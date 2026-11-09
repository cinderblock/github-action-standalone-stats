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
2. ▶ **(current)** Phase 1, foundations: `collect` + `publish` split, compact data model, single
   branch under `stats/`, retry-safe push, test readers (JUnit, CTRF, Allure), badges, job summary,
   Allure generation removed, dogfood on this repo's CI.
3. Phase 2, coverage: lcov + Cobertura, path normalization, Codecov-style merge, flags,
   components, carryforward, patch coverage, coverage badges.
4. Phase 3, viewer SPA.
5. Phase 4, PR comments (`workflow_run` companion), thresholds.
6. Release as a set with the two sibling actions (needs a yes).

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
- [ ] PR #24 green after the auth fix, then merge (needs Cameron's yes) so master pushes record
- [ ] First recorded run on master: check `stats/` on Pages, badge, dashboard
- [ ] Phase 2 coverage

## Open questions for the user

1. **Viewer stack:** React 19 + Vite, like `ssg-base`, built into `dist/viewer/` at dev time, with
   nothing built at publish time (recommended). Or Preact for a smaller bundle?
2. **Own reporter plugins:** recommended *not yet*. CTRF already has reporters for jest, mocha,
   vitest, playwright, cypress, pytest, Go, .NET, Rust and more, and every gap I know of (bun test,
   node:test, gtest, ctest) emits JUnit. We read CTRF, JUnit and Allure natively. Write our own
   reporter only where both lose data we need.

## Things not to do

- Don't work in the `Claude Update All` checkout.
- Don't tag or release.
- Don't push to or modify `cinderblock/bindings-cpp` / `node-serialport`.
- Don't delete `archive/*` branches. Don't force-push `gh-pages`.
