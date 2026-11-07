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
- Existing remote branches here: `gh-pages` (2020/2025 prototype Allure + vitest reports, 3.2 MB
  tree; Pages is enabled, legacy build from `gh-pages` `/`) and `cleanup-test` (2020, stale).
- Sample consumer artifacts (fork run 42308406736 of `cinderblock/bindings-cpp`, node 24 on each OS)
  downloaded to scratchpad `serialport-artifacts/` (session-scoped; re-download with
  `gh run download 42308406736 -R cinderblock/bindings-cpp -n coverage-<os>-node-24.x`).

## Decisions already made (don't re-ask)

- No tagging or releasing without Cameron's explicit yes.
- Don't touch the serialport repos from this thread.
- Bun toolchain; `dist/` committed.

## Plan / steps

1. ▶ **(current)** Research and recommendation: `plans/design-recommendation.md`. Waiting on
   Cameron's call before building.
2. Coverage implementation (after sign-off).
3. Unified UI (if chosen).
4. Dogfood: this repo's own CI publishes its stats; then a serialport fork pilot (that thread's call).
5. Release as a set with the two sibling actions (needs a yes).

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

## Progress log

- [x] Read handoff plan, PLAN.md entry, serialport plan, the whole `src/`
- [x] Inspected leftover `gh-pages`/`cleanup-test` branches and Pages config
- [x] Pulled real lcov/Cobertura artifacts from the serialport fork
- [x] Prior-art research (benchmark-action, py-cov-action, insightsengineering, Allure 2/3, git-perf, EnricoMi/dorny, GitHub Code Quality, Codecov merge rules)
- [x] Wrote `plans/design-recommendation.md`
- [ ] Cameron's decision on the recommendation

## Open questions for the user

Five questions are in `plans/design-recommendation.md` §8 (direction, one vs two branches, default subdir, old `gh-pages`/`cleanup-test`, test input formats).

## Things not to do

- Don't work in the `Claude Update All` checkout.
- Don't tag or release.
- Don't push to or modify `cinderblock/bindings-cpp` / `node-serialport`.
- Don't delete the old `gh-pages`/`cleanup-test` branches without asking (they're on the remote).
