# standalone-stats: design review and recommendation

Written 2026-11-07 for Cameron's decision **before building**. Living plan: `plans/next-steps.md`.

## TL;DR of the recommendation

1. **Keep git as the store, but move to one branch.** By default, data and viewer go in a subdirectory
   of `gh-pages`, with a separate data branch only when Pages is deployed from Actions. A git ref is
   the only free, durable, atomic store an Action can write with `GITHUB_TOKEN`, so nothing else
   replaces it.
2. **Replace raw Allure results with our own compact JSON.** Write one small summary file per run,
   plus a derived index that the viewer reads. Line-level detail is kept only for recent commits.
3. **Fan-in, not every job pushing.** Each matrix job runs a light `collect` step, which normalizes
   paths, tags flags and uploads an artifact. One `publish` job merges and pushes. That removes
   matrix races and is our `after_n_builds`.
4. **Our own unified UI, and drop Allure.** Tests come in as **JUnit XML**, which every runner can
   emit; coverage comes in as **lcov + Cobertura**. Nothing has been released and nobody uses this
   yet, so a clean break costs nothing.
5. **Fork PRs get a degraded but useful path.** The run's job summary works with no write access,
   and an optional `workflow_run` companion posts PR comments. Fork data is never written into
   history.

The reasoning follows.

---

## 1. What's wrong with the current design (independent of any redesign)

| Problem | Where | Effect |
| --- | --- | --- |
| Every run's raw `*-result.json` is unioned into `allure-data` forever and `allure generate` runs over the whole pile | `src/main.ts` `publishData` / merge step | Allure groups results by test identity and shows **all older runs as retries** of the newest ([docs](https://allurereport.org/docs/history-and-retries/)). Deleted tests never disappear. Attachments pile up. Only `history/` should carry forward. |
| README says orphan branches "don't bloat clones of your main branch" | README "Architecture" | Wrong: a default `git clone` fetches **every** branch. Data-branch history ships with every full clone. |
| One `git push`, no retry | `src/utils/commitAndPush.ts` | Two overlapping runs means the second fails non-fast-forward. In a matrix where every job publishes, all but one fail. |
| Data branch cloned twice per run (scratch for merge, then again for publish) | `src/main.ts` | A push that lands between the two clones gets silently dropped from the report input. |
| Allure 2 needs Java and ships ~2.4 MB of app per report | measured on this repo's old `gh-pages` | Heavy, Linux-centric, and every publish rewrites it. |
| No coverage at all | — | The reason we're here. |

So the current code needs real changes even to stay Allure-only.

## 2. Prior art (how others store history)

Full research notes are in the thread. The highlights:

- **benchmark-action/github-action-benchmark:** one `data.js` file on `gh-pages`, with an optional
  external repo (PAT). On a rejected push it **re-clones and re-applies, up to 10 times**. Fork PRs:
  "don't auto-push from PRs". The closest analogue to what we'd build.
- **py-cov-action/python-coverage-comment-action:** an orphan data branch (badge, shields JSON,
  comparison JSON, HTML). Matrix jobs upload `.coverage.*` and **one fan-in job combines** them.
  Fork PRs use the **artifact + `workflow_run`** two-workflow pattern. No push retry; it relies on
  `concurrency` groups.
- **insightsengineering/coverage-action:** the only coverage action that keeps history. It stores
  Cobertura XML on a branch and diffs against a base branch.
- **lcov-reporter / cobertura-action / CodeCoverageSummary:** PR comments only, no history.
- **mgrybyk allure-report-branch-action / simple-elf allure-report-action:** reports committed to
  `gh-pages`. Their docs say "don't run concurrently" and use a concurrency group plus
  `pull --rebase -X ours`. There's no retention.
- **EnricoMi publish-unit-test-result-action:** no storage at all. It stashes a gzip+base64 stats
  digest *inside the check-run summary* and reads the earlier commit's check run to compare.
  Clever, but useless for trends or a dashboard.
- **kaihowl/git-perf:** **git notes** (`refs/notes/perf-v3`) with the `cat_sort_uniq` merge
  strategy, per-writer temporary refs, and push with backoff. It works, but notes aren't fetched by
  default, aren't shown by GitHub, aren't servable by Pages, and purging needs a rewrite.
- **Allure 3** (npm `allure` 3.33, pure JS, no Java, Node ≥ 22.18, not labeled GA): history is a
  single append-only **`history.jsonl`** with `historyLimit` pruning. It reads JUnit XML natively.
  **No coverage** and no coverage plugin.
- **GitHub Code Quality coverage** (GA 2026-07-20): `actions/upload-code-coverage`, **Cobertura
  only**, an aggregate % on PRs and ruleset gates, **$10/active committer/month on Team/Enterprise**,
  **no fork PRs**. It has no history or trend dashboard that I could find. It's not a substitute,
  but it's worth knowing we could *also* emit to it.
- **Codecov merge semantics** (what we emulate): every upload is a session, and sessions are merged,
  never overwritten. Per line: max of hits. Branch partials merge by intersecting the *missed*
  branch sets when identities are known, otherwise by the max numerator and denominator. Flags are
  upload tags. Components are path/flag filters computed at read time. Carryforward reuses a flag's
  last data when it's missing. `after_n_builds` waits for N uploads.

**Patterns across the tools:** artifact + `workflow_run` for forks, a fan-in job for matrices,
re-clone-and-retry for push races, and none of them have a good long-term history format.

## 3. Storage options compared

| Option | History / trends | Repo bloat | Fork PRs | Matrix concurrency | Multi-repo | Privacy | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Branch in same repo** (current idea) | Durable, in git | Grows the repo; every full clone fetches it. Fine if the data is compact. | Can't push (read-only token) | Push races; fixable by fan-in + re-apply retry | Per repo only | Same visibility as the repo; Pages is a separate question | **Keep**, with compact data |
| **Two branches** (data + `gh-pages`) | Same | Same | Same | Two pushes per run, two race windows, non-atomic | — | A data branch can hold non-public detail only if it isn't served | Collapse to **one** unless Pages comes from Actions |
| **Artifacts + `deploy-pages`** | **No**: artifacts expire (Pages artifact default retention 1 day, max 90/400); the only "previous state" is the live site | None | Can't deploy from forks | Last deploy wins (lost updates) | — | — | Not a source of truth. Fine as an **output** mode. |
| **Pages-as-database** (fetch last `data.json` from the live site, append, redeploy) | Fragile | None | No | Lost updates | — | Private Pages needs auth | Reject |
| **Separate stats repo** | Durable | Keeps the main repo clean | No | Same races, more writers if shared | **Yes**: one dashboard for many repos | Can make stats public for private code, which means it can **leak** paths and test names | **Keep as opt-in** (needs a PAT or GitHub App token) |
| **Git notes** | Keyed by SHA natively | Small | No | Notes merge on conflict | Awkward | Not shown anywhere | Reject. A branch keyed by SHA does the same with better tooling, and squash-merges orphan notes from PR SHAs. |
| **Compact JSON in branch** | Yes | Small, diff/delta-friendly | — | Per-run files never conflict | Namespaced dirs | — | **Yes** |
| **SQLite in branch** | Yes | Every write rewrites a binary blob, so poor deltas | — | Unmergeable | — | — | Reject (browser also needs sql.js wasm) |
| **Release assets** (rolling `stats` release) | Durable, out of git history | None | No | No CAS: lost updates | — | — | Reject (clutters Releases; likely no CORS for the viewer to fetch) |
| **Actions cache** | Evictable after 7 days unused | None | — | — | — | — | Reject |
| **Check-run summary digest** (EnricoMi) | Only the previous commit | None | Partly | — | — | — | Reject for trends |

**Why a git ref still wins:** it's the only store that is free, durable, readable by the viewer
(once served by Pages), writable with plain `GITHUB_TOKEN`, and gives us **compare-and-swap for
free** (a non-fast-forward push is rejected, so we never silently lose a write).

## 4. Proposed architecture

### Data flow

```
matrix job (each OS / node / …)                 fan-in job (needs: test, if: always())
───────────────────────────────                 ───────────────────────────────────────
tests → junit.xml                                download all standalone-stats-* artifacts
coverage → lcov.info, *.cobertura.xml            merge sessions (Codecov semantics)
uses: …/standalone-stats/collect@v1   ──artifact──▶ uses: …/standalone-stats@v1
  · parse, normalize paths vs THIS job's            · clone branch (depth 1)
    GITHUB_WORKSPACE (D:\a\… → src/…)               · write runs/<id>.json, detail, badges, viewer
  · tag flags (os, node-24, …)                      · regenerate index.json
  · emit compact JSON (+ raw files, optional)        · push; on reject: re-clone, re-apply, retry
                                                    · job summary (+ PR comment if allowed)
```

Path normalization **must** happen in the producing job. The serialport fork's real Windows output
shows why: `<source>D:</source>` + `filename="a\bindings-cpp\bindings-cpp\src\serialport.cpp"`, and
`SF:lib\darwin.ts` from nyc. The publish job can't know another job's workspace.

### Layout on the branch (default `gh-pages`, subdir `stats/`)

```
stats/
  index.html, assets/…        viewer, copied from the action at its version
  badges/tests.svg, coverage.svg, coverage-<component>.svg, flag-<flag>.svg
  data/
    meta.json                 schema version, repo, components/flags config snapshot
    index.json                derived: series for charts (per run: totals, per flag, per component,
                              test counts, duration). Rebuilt from runs/ on every publish.
    runs/2026/11/<runId>-<attempt>.json   per-run summary: commit, ref, event, time, per-file
                              per-flag line/branch totals, test counts + failing/flaky test ids
    detail/<sha>.json         line-level hits per file per flag, kept for the latest N commits on
                              the default branch (+ open PR heads, if stored); pruned beyond that
```

- **Per-run files never conflict.** On a rejected push we re-clone, drop our new files back in,
  regenerate `index.json`, and push again. That's conflict-free by construction (the benchmark-action
  approach, done properly).
- **Size, rough numbers for bindings-cpp:** a run summary is ~5–10 KB of JSON and a detail file
  ~30–60 KB, before git's zlib (~5–10× on JSON) and deltas. With detail pruned to the last ~50
  commits, a year of one-run-per-push is single-digit MB in history. An Allure 2 publish is 2.4 MB
  of app code each time.
- **No source code is stored.** For public repos the viewer fetches source at the run's SHA from
  `raw.githubusercontent.com` for the line view. For private repos the line view shows hits only,
  unless the user opts in.
- **Optional squash** (`data-history: squash-after-N`) to cap history growth. It's a force-push of a
  data branch, so it's **off by default** and documented loudly.

### Modes

- `pages: branch` (default): one branch, as above.
- `pages: artifact`: data on a non-Pages branch (`stats-data`); the action writes the full site to a
  directory output for `actions/upload-pages-artifact`. This is for repos whose Pages already
  deploys from Actions. The Pages source is either/or, so we can't own it.
- `pages: none`: data + badges only.
- `repo: owner/stats`: a separate repo (PAT/App token). The layout is namespaced
  `<owner>/<repo>/stats/…`, so one stats repo can host many projects. An org-level index page comes
  later.

### Fork PRs (tiered)

1. **Always works:** the fan-in job compares against the base's data (read-only fetch of the public
   branch) and writes the **job summary**: coverage delta, patch coverage, new failures. No write
   permission is needed.
2. **Optional companion workflow** (`workflow_run`, a documented template): posts or updates a sticky
   PR comment from the artifact. That's the same pattern py-cov-action, EnricoMi and dorny use. The
   artifact is treated strictly as data: parsed JSON, never executed, size-capped.
3. **Fork data is never written into history.** Default-branch pushes build the trend line. Same-repo
   PRs can optionally store `prs/<n>` detail, pruned on close.

### Concurrency

- Matrix: solved by the fan-in.
- Overlapping runs: the README recommends
  `concurrency: { group: standalone-stats-${{ github.repository }}, cancel-in-progress: false }`
  on the publish job, *and* the action retries anyway (re-clone/re-apply, bounded with backoff).
  Belt and braces, because users won't all add the group.

### Coverage model (phase 2, the Codecov-like part)

- **Inputs:** lcov (`SF/DA/BRDA/FN`) and Cobertura (gcovr, OpenCppCoverage, coverage.py, JaCoCo
  via conversion). Later, maybe Istanbul JSON / LLVM JSON.
- **Sessions:** one per uploaded file per job, tagged with its job's **flags**.
- **Merge** per file per line: coverable if any session says so (the OSes really disagree: 641 vs
  834 vs 871 coverable C++ lines). Hits are summed (report "hit" as > 0). Branches use lcov `BRDA`
  identities where available. Cobertura `condition-coverage` (counts only) falls back to
  Codecov's max-numerator/max-denominator rule. Mixed lcov + Cobertura branch data for the same
  file is a known Codecov flaw; we'll merge conservatively and document it.
- **Components:** path globs → name, from a config file (`.github/standalone-stats.yml`) or inputs.
  The default is one component per language by extension (TS vs C++ falls out with no config).
  They're computed at read time, so changing them reprocesses history from stored per-file totals.
- **Flags:** per-flag totals and trends (e.g. Windows vs Linux C++ coverage). **Carryforward** for
  flags missing from a run.
- **Patch coverage:** the PR diff (compare API) intersected with line detail. This is Codecov's most
  useful feature and the main reason people install it.
- **Checks:** optional thresholds (total / component / patch) that fail the publish step or set a
  commit status. Later: GitHub Code Quality's `upload-code-coverage` as an extra output for people
  who pay for it.

### Tests model

- **Input: JUnit XML** (mocha-junit-reporter, jest-junit, vitest, `bun test --reporter=junit`,
  pytest, ctest, gtest, JUnit/Gradle). This is the universal format; Allure results aren't. An
  **Allure-results reader** can come later if anyone needs it.
- **Stored per run:** totals, durations, and the ids of failing/skipped tests (not every passing
  test). Per-test history in a rolling `tests-index.json` (last N runs: pass/fail/duration) gives
  flaky detection and slowest-test trends without storing full results forever.
- Failure messages and stack traces are kept for the latest run and PR runs only. They can contain
  paths, environment and secrets-adjacent noise, so they're truncated and size-capped.

## 5. UI: our own vs Allure — my opinion

**Build our own. Drop Allure report generation entirely.**

- Allure is a test-result explorer (steps, attachments, retries). It has no notion of coverage, and
  Allure 3 still has none. Coverage would be a second, unrelated UI next to it, which is the
  opposite of "unified".
- Allure 2 needs Java and ~2.4 MB of app code per publish. Allure 3 fixes Java but isn't labeled GA,
  needs Node ≥ 22.18, and "most CI integrations are still in development".
- Our consumer (serialport) doesn't emit Allure results. It would need an Allure reporter added
  upstream, and Cameron doesn't control upstream. JUnit + lcov + Cobertura cover it with tiny or no
  changes.
- Nobody uses this action and nothing is tagged, so this is the cheapest moment there will ever be
  to change direction.
- What we lose: Allure's per-test step and attachment drill-down. For the projects in view (unit
  tests, mocha, C++), the summary, failure list, flaky and slow-test views are what's actually used.

**Viewer design (phase 3):** a static SPA bundled by Bun into `dist/viewer/` and copied into the
branch, so there's no build at publish time. Preact + uPlot (both tiny), with a light/dark theme.
Views:

- **Overview:** badges, latest totals, trends for coverage % (total, per component, per flag) and
  for tests (pass/fail/skip, duration).
- **Coverage tree:** directory → file, with columns per flag and a component filter.
- **File view:** line hits per flag (Windows-only lines visibly different from Linux-only),
  with source fetched from GitHub for public repos.
- **Tests:** latest failures, flaky tests (status flipped within the last N runs), slowest tests.
- **Compare:** any two runs or commits, and PR vs base.

Badges and summary generation come in phase 2, so coverage is useful before the viewer lands.

## 6. Privacy

- Whatever is in a Pages site is **public** unless the repo is on Enterprise Cloud with private
  Pages. A private repo on Pro/Team publishing stats exposes file paths, test names and failure
  messages publicly.
- So: if the repo is private and the Pages site is public (the Pages API reports `public`), the
  action **refuses to publish the viewer/detail** unless `allow-public-pages-for-private-repo: true`.
  Totals-only badges are still fine.
- No source is ever stored (see above). Failure text is truncated.
- A separate stats repo can be public for private code. That's exactly the leak case, and it gets
  the same guard.

## 7. Phasing

1. **Foundations (rewrite):** collect/publish split, compact data model, single-branch storage,
   retry-safe push, JUnit test ingestion, badges, job summary. Remove Allure. Dogfood on this repo's
   own CI (`bun test --reporter=junit` + `--coverage` lcov).
2. **Coverage:** lcov + Cobertura parsers with path normalization (fixtures: the serialport fork
   artifacts), Codecov-style merge, flags, components, carryforward, patch coverage in the job
   summary, coverage badges.
3. **Viewer:** the SPA above.
4. **PR comments:** the `workflow_run` companion. Thresholds/checks.
5. **Release** with the sibling actions (Cameron's yes). A serialport *fork* pilot is that
   thread's call.

## 8. Questions for Cameron

1. **Direction:** own compact format + own UI, Allure dropped (recommended), *or* keep Allure for
   tests and add coverage beside it, *or* Allure 3 as the test UI with our coverage UI?
2. **One branch or two by default:** a single `gh-pages` + `stats/` subdir (recommended), or keep a
   separate data branch always?
3. **Default subdir:** `stats/` (safe next to existing Pages content; URL `…github.io/<repo>/stats/`,
   recommended) or the site root?
4. **This repo's old `gh-pages`** (2020/2025 Allure + vitest prototype reports) and the stale
   `cleanup-test` branch: OK to replace `gh-pages` contents when dogfooding, and to delete
   `cleanup-test`? (Both are remote changes, so I'll wait for a yes.)
5. **Test input:** JUnit XML only to start (recommended), or also an Allure-results reader from day
   one?
