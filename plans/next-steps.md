# standalone-stats: next steps (storage design, coverage, unified UI)

## Goal

Turn `cinderblock/github-action-standalone-stats` from an Allure-only test-report publisher into
a self-hosted, Codecov-like **test + coverage** stats action with no third-party service. The
first real consumer is the serialport coverage work (TS lcov from nyc, C++ Cobertura from gcovr
and OpenCppCoverage, on a Linux/macOS/Windows matrix).

Order of work, as Cameron set it:

1. Investigate the design (format, storage, alternatives, trade-offs, prior art) and bring a
   recommendation **before building**.
2. Implement coverage: lcov + Cobertura, merged across a matrix, with per-component and per-flag
   breakdowns.
3. Possibly replace Allure's report with our own unified test + coverage UI (my opinion goes into
   the recommendation).

## Environment / context

- Checkout: `C:\Users\camer\git\Personal Projects\github-action-standalone-stats` (fresh clone at
  `9b8b120`, branch `master`). **Not** `C:\Users\camer\git\Claude Update All\github-action-standalone-stats`
  (that belongs to the bulk-update workflow).
- Earlier handoff: `C:\Users\camer\git\Claude Update All\plans\standalone-stats.md`. Its
  `PLAN.md` entry (line ~196) says tags on all three `github-action-*` repos are held until this
  one is finished, so they release as a coherent set.
- Consumer plan: `C:\Users\camer\git\Personal Projects\serialport\plans\serialport-coverage.md`.
  **Don't change the serialport repos from this thread.**
- Toolchain: Bun (`bun.lock`), TypeScript 7, `@actions/core` 3, ESM bundle in `dist/index.js`,
  `runs.using: node24`. CI: lint, test, build, plus a `bundle-loads` job.
- Remote branches here: `gh-pages` (2020/2025 prototype Allure + vitest reports, 3.2 MB tree;
  Pages is enabled, legacy build from `gh-pages` `/`). Archived 2026-11-07 as
  `archive/gh-pages` (`0f6dafb`) and `archive/cleanup-test` (`cdc0fa0`); `cleanup-test` deleted.
  `gh-pages` itself stays (Pages builds from it); dogfooding removes the old prototype dirs with a
  normal commit, no force-push.
- Sample consumer artifacts (fork run 42308406736 of `cinderblock/bindings-cpp`, node 24 on each OS)
  downloaded to scratchpad `serialport-artifacts/` (session-scoped; re-download with
  `gh run download 42308406736 -R cinderblock/bindings-cpp -n coverage-<os>-node-24.x`).

## Decisions already made (don't re-ask)

- No tagging or releasing without Cameron's explicit yes.
- Don't touch the serialport repos from this thread.
- Bun toolchain; `dist/` committed.
- **Own compact format + own unified UI; Allure report generation dropped** (Cameron, 2026-11-07: "yes").
- **One branch by default**: data + viewer together in `gh-pages`, replacing today's two
  (`allure-data` for raw results/history + `gh-pages` for the rendered report). A separate data
  branch only in `pages: artifact` mode. (Cameron: "ok".)
- **Default subdir `stats/`** (Cameron: "I like it").
- **Old branches archived to `archive/*`, not deleted** (Cameron, 2026-11-07). Done.
- **Multiple test input formats from day one**: JUnit XML, CTRF JSON, Allure 2 results; TRX/TAP next.
- **Viewer is built at development time, not publish time.** No Rust binary and no Vite/SSG run
  inside the action. A static SPA is bundled once into `dist/viewer/` and copied in; it reads
  `data/*.json` client-side. Stack follows `ssg-base` (React 19 + Vite + TS), but SPA output with
  hash routing (Pages has no rewrites). Cameron raised Rust/Vite/ssg-base; this is my
  recommendation and isn't confirmed yet (see open questions).

## Plan / steps

1. ✅ Research and recommendation: `plans/design-recommendation.md`. Approved 2026-11-07.
2. ✅ Phase 1, foundations: `collect` + `publish` split, compact data model, single
   branch under `stats/`, retry-safe push, test readers (JUnit, CTRF, Allure), badges, job summary,
   Allure generation removed, dogfood on this repo's CI.
3. ✅ Phase 2, coverage: lcov + Cobertura, path normalization, Codecov-style merge, flags,
   components, carryforward, patch coverage, coverage badges.
4. ✅ Phase 3, viewer SPA: React + Vite dashboard (runs, tests, coverage tree, per-line view).
5. ▶ **(next, needs a go-ahead)** Phase 4, PR comments (`workflow_run` companion), thresholds.
6. Release as a set with the two sibling actions (needs a yes).

### Phase 2 design (decided while building, 2026-11-08)

- **Inputs:** `coverage` (globs) + `coverage-format` (`auto`/`lcov`/`cobertura`) on both `collect`
  and publish. `collect` needs `tests` or `coverage` (either). JaCoCo XML isn't Cobertura; error
  with a hint, convert first.
- **In memory:** per file, per line `{hits, br?}` where `br` is a `0/1` string, one char per
  branch. lcov `BRDA` gives real identities (ordered as listed). Cobertura's
  `condition-coverage="50% (1/2)"` has counts only, encoded front-filled (`10`), so OR-merging
  front-filled strings reproduces Codecov's max-covered/max-total rule.
- **Merge across sessions:** coverable lines = union; hits summed; branches OR'd, padded to the
  longest. Line % = lines with hits > 0 / coverable lines (what the tools report). Partials are
  not counted as misses (Codecov does; that confuses people).
- **Paths:** resolved in `collect` against its own workspace and Cobertura `<source>`s, preferring
  a candidate that exists on disk. Absolute paths outside the workspace (system headers) are
  dropped and counted. If a report resolves nothing inside the workspace but has relative names,
  keep them as-is with a warning.
- **Groups:** stored line detail is grouped by an upload's flag set. Totals come from merging all
  groups. **Carryforward** (`carryforward` input: flag list or `true`): a baseline group is carried
  in when none of its flags is present this run and all of them are carryforward-enabled.
- **Components:** publish input `components`, one `Name: glob, glob` per line; a file may be in
  several. Globs without `/` match the basename. Default (empty): one per language by extension.
- **Patch coverage:** PRs diff `pull_request.base.sha...head` (merge-base) and pushes diff
  `before...sha`, via the compare API. Added lines that are coverable count; hit/coverable is the
  patch %. The compare API caps files (300) and omits huge patches; marked `partial`.
- **Storage:** the run record gets `coverage` (totals, per flag, per component, per upload, patch).
  Line detail goes in `data/detail/<runKey>.json` and is kept for the newest `detail-window` (50)
  runs only. `index.json` rows get compact `[hit,total]` pairs. Schema stays 1 (fields optional,
  nothing released yet).
- **Badges:** `coverage.svg`, `coverage-<component>.svg`, `flag-<flag>.svg`.
- Deferred: thresholds/checks (phase 4), function coverage, a path-prefix fix-up input for
  monorepos.

### Phase 3 design (Cameron: "go go go", 2026-11-10)

- **Stack:** React 19 + Vite 8 + TS, a Vite project in `viewer/` (its own `tsconfig.json` with DOM
  and JSX). `bun run build` runs the Vite build into `dist/viewer/` (relative `base: './'`, so it
  works under any stats subdir). No router dependency: a small hash router (Pages has no rewrites).
- **Shared code:** the viewer imports `src/coverage/model.ts` (decode, merge, totals) and the
  types in `src/model.ts`, so the browser merges detail exactly the way publish does.
- **Routes:** `#/` overview, `#/runs`, `#/runs/<key>`, `#/tests`, `#/tests/<id>`,
  `#/coverage/<key>?path=<dir>&flags=<a,b>` (tree), `#/coverage/<key>/file/<path>` (lines).
- **Source text** for the line view comes from `raw.githubusercontent.com/<repo>/<sha>/<path>`
  (public repos, CORS allowed). If that fails (private repo), lines show without source.
- **Charts:** hand-written SVG, dataviz skill rules (status colors for pass/fail, categorical
  order for flags/components, tooltips on hover _and_ tap, no `title=` attributes anywhere).
- **Times:** local 12-hour with zone, UTC in smaller text beside it.
- **Dev data:** `scripts/demo-data.ts` drives the real pipeline (`buildCoverage`, `buildRecord`,
  `applyRun`) over the serialport fixtures with seeded noise: ~40 runs on master plus PR runs,
  failures, flaky tests, carryforward, patch coverage. `bun run viewer:dev` serves it.
- **E2E:** Playwright (headless Chromium) loads the built viewer over the demo data and checks
  every route renders with no console errors. Separate CI job.

## Findings / gotchas

- **The current design double-counts.** `main.ts` unions every run's raw `*-result.json` into the
  `allure-data` branch forever, then runs `allure generate` on the whole pile. Only `history/`
  should carry forward. See the recommendation for details.
- **"Orphan branches don't bloat clones" (README) is wrong.** A default `git clone` fetches every
  branch, so data-branch objects ship with every full clone. Data size matters.
- **No concurrency handling.** `commitAndPush` does one `git push`; a racing run gets a
  non-fast-forward rejection and the action fails. The data branch is also cloned twice per run
  (scratch + publish), so a push between the two is silently overwritten in the merge input.
- An Allure 2 report is ~2.4 MB of fixed app code (`styles.css` 1.6 MB + `app.js` 0.8 MB) before
  any data (measured on the old `gh-pages`).
- **Real consumer paths are messy:**
  - nyc lcov on Windows writes `SF:lib\darwin.ts` (backslashes).
  - OpenCppCoverage Cobertura has `<source>D:</source>` and `filename="a\bindings-cpp\bindings-cpp\src\serialport.cpp"`,
    with the package named after the binary (`...\build\Debug\bindings.node`). No branch data.
  - gcovr Cobertura has repo-relative `src/poller.cpp`, a `<source>` of the workspace, and
    `condition-coverage="50% (1/2)"` per line (counts only, not branch identity).
  - Each OS reports a different set of coverable lines for the same files (`lines-valid` 641 Linux,
    834 macOS, 871 Windows), so a merge must union coverable lines, not assume one line set.
  - So paths must be normalized in the job that produced them (it knows its own `GITHUB_WORKSPACE`).

- **`${{ toJSON(matrix) }}` and `${{ strategy.job-index }}` work as `inputs.*.default` in a
  node24 action's `action.yml`** (probe run 42356876323, 2026-11-07). So `collect` defaults its
  identity to job + matrix: unique per leg and stable across re-runs, with no user config.
- **Re-runs keep old artifacts.** "Re-run failed jobs" leaves the failed attempt's artifact in the
  run, so publish must dedupe by identity and keep the highest attempt.
- **`actions/checkout` + our token = 400 "Duplicate header: Authorization".** Checkout persists an
  `http.https://github.com/.extraheader` for the workspace (via `includeIf`); git sent it plus ours.
  Seen in PR #24's first stats job (run 42357934887): the baseline read failed and was swallowed as
  "No baseline available". Fixed: empty `extraheader` values reset the list before ours, and git
  never runs in the workspace by default. Covered by a test against a local HTTP server.
- **Runners evaluate `${{ }}` inside `action.yml` input descriptions.** A `${{ runner.os }}` example
  in `collect`'s `flags` description failed every job: "Unrecognized named-value: 'runner'" (PR #25,
  run 42576274257). Never put expressions in descriptions.
- **The repo's `.gitignore` had `coverage/` unanchored**, which silently ignored `src/coverage/`
  and `test/fixtures/coverage/`. Now `/coverage/`.
- **gcovr lists a line once per function on it** (Linux report: poller.cpp:33, :43,
  serialport.cpp:364) and counts each copy in `lines-valid`. We count a line once, so our totals
  are 3 lower than gcovr's 641 there. Tests compare against the report minus duplicates.
- **nyc writes `BRDA` on lines with no `DA`** (a branch's start line). Counting those as lines gave
  504 vs LF=499. They're stored as branch-only (`hits: -1`): branches count, the line doesn't.
- **fast-xml-parser returns text-only elements as strings**, so `children()` (objects only) lost
  every Cobertura `<source>`. Read them directly.
- **An effect that returns a value crashes React on cleanup.** `useEffect(() => window.scrollTo(0, 0))`
  returned something truthy in Chromium; React called it as the cleanup: "destroy_ is not a
  function" on every navigation. Effects always get block bodies. Only the headless e2e run caught it.
- **The publisher's viewer copy needs `assets/` cleared first.** Vite asset names are content-hashed,
  so a plain `cp` would leave every old version's bundle on the branch. `applyRun` removes `assets/`.
- **Root `tsc` (NodeNext) type-checks viewer files the unit tests import**, so viewer imports use
  `.js` extensions (Vite and TS Bundler resolution accept them) and `router.ts` references the DOM lib.
- **A swallowed baseline error hides real failures.** The job went green while compare was broken.
  Now a warning (`core.warning`) instead of info.

## Progress log

- [x] Read handoff plan, PLAN.md entry, serialport plan, the whole `src/`
- [x] Inspected leftover `gh-pages`/`cleanup-test` branches and Pages config
- [x] Pulled real lcov/Cobertura artifacts from the serialport fork
- [x] Prior-art research (benchmark-action, py-cov-action, insightsengineering, Allure 2/3, git-perf, EnricoMi/dorny, GitHub Code Quality, Codecov merge rules)
- [x] Wrote `plans/design-recommendation.md`
- [x] Cameron's decision on the recommendation (2026-11-07)
- [x] Archived old branches to `archive/*`
- [x] Probe (run 42356876323, branch deleted): `strategy`/`matrix` contexts ARE readable in action input defaults
- [x] Phase 1 implementation: PR #24 (https://github.com/cinderblock/github-action-standalone-stats/pull/24)
- [x] `gh-pages` cleanup: prototype `allure-report/`, `vitest/`, `dashboard.svg` removed, root redirects
      to `stats/` (`555bf23`; old content stays in `archive/gh-pages`)
- [x] Fixed duplicate Authorization header (see findings)
- [x] PR #24 green after the auth fix; squash-merged as `e4acd24` with Cameron's yes (2026-11-08)
- [x] First recorded run on master (run 42572413395, Nov 8 10:21 PM PST (06:21Z Nov 9)): pushed on
      attempt 1 as `gh-pages@5a4b3bd`; Pages serves `stats/`, `data/index.json` and the badge
      ("tests: 150 passing" = 50 tests × 3 OSes)
- [x] Phase 2 coverage engine (`badd6ab`, branch `phase-2`): lcov + Cobertura readers, path
      resolution, merge, flags, components, carryforward, patch coverage, detail files, badges,
      summary section, dashboard section, README, dogfood in CI
- [x] Phase 2 PR #25 green on 3 OSes (after the description fix); squash-merged as `1b9ab71`
- [x] First master run with coverage (run 42580049133, Nov 8 11:08 PM PST (07:08Z Nov 9)):
      `gh-pages@c658d21`, detail file, `coverage.svg` (87.4%), TypeScript component and
      Linux/Windows/macOS flag badges live on Pages; push patch coverage 749/832
- [x] Phase 3 dashboard built (branch `phase-3`): overview, runs, run, tests, test, coverage
  tree and per-line pages; demo data generator; unit tests (`test/viewer.test.ts`); Playwright
  e2e on desktop and phone sizes (21 pass); CI `dashboard` job; README section
- [x] Phase 3 PR #26 green on all 6 checks; squash-merged as `d214827` on Cameron's yes
  (2026-11-10)
- [x] First master run with the dashboard (run 42909588933, Nov 10 1:55 PM PST (21:55Z)): all
  jobs green, `gh-pages@8c9d326`, live at
  https://cinderblock.github.io/github-action-standalone-stats/stats/; checked headless: overview,
  runs, tests and coverage render real data with no console errors
- [ ] Phase 4: PR comments and thresholds (needs a go-ahead)

Note: the master run on `2c77ef7` (Nov 8 11:35 PM PST (07:35Z Nov 9)) failed only on macOS with
`Unexpected HTTP response: 504` during setup, before any test ran. Transient runner-side download
error, not a code failure; the next master run was green on all OSes.

## Open questions for the user

1. **Badge count:** the tests badge sums results across matrix jobs (150 = 50 × 3 OSes). Show
   unique tests instead ("50 passing · 3 jobs")? Recommended: unique tests, jobs in the tooltip.

Answered with a plain "yes" on 2026-11-08 alongside the merge, taken as accepting both
recommendations (Cameron may correct): viewer is React 19 + Vite built at dev time; no own
reporter plugins yet (CTRF + JUnit cover the gaps).

## Things not to do

- Don't work in the `Claude Update All` checkout.
- Don't tag or release.
- Don't push to or modify `cinderblock/bindings-cpp` / `node-serialport`.
- Don't delete `archive/*` branches. Don't force-push `gh-pages`.
