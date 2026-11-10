# Standalone Stats

Self-hosted test and coverage stats for GitHub Actions: merge results and
coverage from every job in a run (a whole OS × version matrix), keep history
on a branch of your own repo, and publish a dashboard and README badges with
GitHub Pages. **No third-party service**, no extra secrets, no Java.

Coverage is merged the way Codecov merges uploads, with per-flag and
per-component breakdowns, carryforward and patch coverage on pull requests.

[![CI](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml)
[![tests](https://cinderblock.github.io/github-action-standalone-stats/stats/badges/tests.svg)](https://cinderblock.github.io/github-action-standalone-stats/stats/)
[![coverage](https://cinderblock.github.io/github-action-standalone-stats/stats/badges/coverage.svg)](https://cinderblock.github.io/github-action-standalone-stats/stats/)

> **Status:** pre-release. There are no tags yet, so pin a commit SHA if you
> try it before `v1` is published.

## What it does

- Reads **JUnit XML**, **CTRF JSON** and **Allure 2 results**, detected
  automatically. That covers bun, node:test, jest, vitest, mocha, pytest,
  gtest, ctest, Surefire/Gradle, Go, .NET, Playwright and more, with each
  framework's own reporter.
- Reads **lcov** and **Cobertura XML** coverage: nyc/istanbul, c8, bun,
  llvm-cov, gcovr, OpenCppCoverage, coverage.py and more.
- In a matrix, each job runs a small `collect` step. One fan-in `publish` job
  merges them all, so jobs never race each other to push.
- Stores each run as a small JSON file on a branch (default `gh-pages`, under
  `stats/`), plus indexes the dashboard reads. No raw report dumps.
- Pull requests get a **job summary** comparing against the target branch:
  new failures, fixed tests, per-job counts, the coverage change and patch
  coverage. That works for fork PRs too, because it doesn't need write access.
- Publishes a dashboard and SVG badges (tests, coverage, and one per
  component and flag). The dashboard is a small static app that reads the
  JSON directly; see [Dashboard](#dashboard).

## Quick start: one job

```yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: write # push the stats branch
      pages: read # lets the privacy check read your Pages settings
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npx jest --ci --coverage --coverageReporters=lcov --reporters=default --reporters=jest-junit

      - name: Publish stats
        if: ${{ !cancelled() }} # publish failures too
        uses: cinderblock/github-action-standalone-stats@<sha>
        with:
          tests: junit.xml
          coverage: coverage/lcov.info
```

Then turn on Pages: **Settings → Pages → Deploy from a branch → `gh-pages` /
`(root)`**. The dashboard is at `https://<owner>.github.io/<repo>/stats/` and
the badge at `…/stats/badges/tests.svg`. The exact Markdown is in the
`badge-markdown` output and in the job summary.

## A matrix: collect in each job, publish once

```yml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npx c8 --reporter=lcov npm test -- --reporter mocha-junit-reporter
      - uses: cinderblock/github-action-standalone-stats/collect@<sha>
        if: ${{ !cancelled() }}
        with:
          tests: test-results.xml
          coverage: coverage/lcov.info
          flags: ${{ runner.os }}

  stats:
    needs: test
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: read
    steps:
      - uses: cinderblock/github-action-standalone-stats@<sha>
```

`collect` tells matrix legs apart on its own (it reads `${{ toJSON(matrix) }}`
as an input default), so there's nothing to configure. It also normalizes file
paths in the job that produced them: `D:\a\repo\repo\src\x.ts` on Windows and
`/home/runner/work/repo/repo/src/x.ts` on Linux both become `src/x.ts`, and the
same test gets the same id on every OS. If you re-run failed jobs, the new
attempt's results replace the old ones instead of being added to them.

The publish job doesn't need a checkout.

## Coverage

Give `collect` (or the publish step, in a single job) your coverage reports
with `coverage:`. lcov and Cobertura are detected from their content, and one
job can upload several: lcov for a native addon's TypeScript and Cobertura for
its C++, say.

**Merging.** Every job's coverage is merged the way Codecov merges uploads. A
line is coverable if any job says so (the OSes really do disagree: each
compiler reports a different set of coverable lines for the same file), hits add up,
and a line counts as covered if any job ran it. lcov branch records keep their
identities, so branches taken on different OSes add up correctly. Cobertura
only has counts per line (`condition-coverage="50% (1/2)"`), so for it the
best count wins. Line coverage is covered lines over coverable lines, the
number the tools themselves report. Unlike Codecov, partly covered lines
aren't counted as misses.

**Paths** are made repo-relative in the job that wrote the report, against
its own workspace and the report's `<source>` entries. On Windows,
OpenCppCoverage's `<source>D:</source>` plus `a\repo\repo\src\x.cpp`, nyc's
`src\x.ts` and gcovr's `src/x.cpp` on Linux all end up as `src/…`. Files
outside the workspace (system headers, dependencies) are dropped and counted
in the log.

**Flags** label a job's uploads (`flags: ${{ runner.os }}, cpp`). Each flag
gets its own totals, trend and badge.

**Carryforward.** When a run skips some jobs (path filters skip the Windows
build, say), set `carryforward: true` or name the flags, and the missing
flags' coverage comes from the last stored run instead of vanishing. The
summary says which flags were carried.

**Components** group files by path. With no configuration there's one per
language, by file extension, so a TypeScript + C++ repo splits on its own. Or
define them on the publish step:

```yml
with:
  components: |
    JavaScript: lib/**
    Native: src/**, binding.gyp
```

A file can be in several components. `**` crosses directories, and a glob
without `/` matches file names anywhere (`*.h`).

**Patch coverage.** The summary shows how many of the coverable lines a pull
request changed actually ran, and lists changed files with missed lines. It
diffs the PR against its base with the compare API; pushes diff against the
previous tip. The API lists at most 300 files, so past that the number is
marked incomplete.

## Which runs are recorded

With `record: auto` (the default), runs from **pushes, schedules and manual
runs on the default branch** are stored, and they make up the history.
Everything else, mostly pull requests, is compared against the history of its
target branch and reported in the job summary, but isn't stored. Set
`record: always` or `never` to override.

Pull requests from forks get a read-only token, so they're never recorded; the
comparison still works. PR comments from fork PRs need a second,
`workflow_run`-triggered workflow. That's on the [roadmap](#roadmap).

## Concurrency

Matrix jobs don't push; only the fan-in job does. When two workflow runs
publish at once, the loser's push is rejected (it isn't a fast-forward). The
action then re-clones the branch, re-applies its run, and pushes again, with
backoff, up to `push-attempts` times. Nothing is merged by hand and nothing is
lost, because every run writes its own file and the indexes are rebuilt from
what's on the branch.

**Don't** put the publish job in a `concurrency` group. GitHub cancels a job
that's already pending in a group when a newer one is queued, so some runs'
stats would silently never be published.

## Privacy

Anything on a GitHub Pages site is public unless your organization uses
access-controlled Pages (Enterprise Cloud). Stats include test names, file
paths and failure messages. If the stats repo is **private** and its public
Pages site serves the stats branch, the action refuses to publish, and says
why in the job summary. Set `allow-public-pages-for-private-repo: true` if
that's what you want. It needs `pages: read` to check; without it, a private
repo is refused rather than guessed about.

Failure messages are truncated to 2000 characters, and no source code is
stored.

## Dashboard

`https://<owner>.github.io/<repo>/stats/` (or wherever your stats directory is
served). Everything is client-side over the stored JSON; there's no server.

- **Overview**: the latest run on the main branch (pick another branch, or all
  of them), a stacked pass/fail/skip trend, a coverage trend (total, by flag or
  by component), latest failures, the flakiest tests and recent runs.
- **Runs**: every stored run, filterable by branch, event and failures. A run's
  page has its jobs, failures with messages, per-flag and per-component
  coverage with the change from its baseline, carried-forward flags and the
  changed files' patch coverage.
- **Tests**: every test seen in the last `history-window` runs, searchable,
  sorted by failing, flakiest (pass↔fail flips) or slowest, with its history
  strip. A test's page charts its duration per run.
- **Coverage**: a directory tree for any run that still has line detail (the
  newest `detail-window` runs), filterable by flag, down to a per-line view:
  hits, branches taken, and the missed ranges to jump to. Source text comes
  from `raw.githubusercontent.com` at the run's commit, so it shows for public
  repositories; private ones get the line data without the text.

Charts answer to hover, tap and the arrow keys. Times are shown in your local
zone with UTC beside them.

## Where things live

Default: branch `gh-pages`, directory `stats/`. It sits next to whatever else
your Pages site serves.

```
stats/
  index.html, assets/              dashboard (replaced on every publish)
  badges/tests.svg, coverage.svg   and coverage-<component>.svg, flag-<flag>.svg
  data/meta.json                   schema version, generator
  data/index.json                  one row per stored run (charts, run list)
  data/tests.json                  per-test history for the last N runs (flaky/slow)
  data/runs/YYYY/MM/<run>-<attempt>.json   one file per stored run
  data/detail/<run>-<attempt>.json         line coverage, newest 50 runs only
```

A run file is a few KB: totals, per-job counts, coverage totals by flag and
component, and the failing tests with their messages (passing tests aren't
listed individually there). Line-level coverage is the bulky part, so it's
only kept for the newest `detail-window` runs. Note that
`git clone` fetches every branch by default, so the stats branch ships with
full clones of your repo. That's why the data is kept compact.

### Other layouts

- **Pages deployed by a workflow** (`actions/deploy-pages`): set `branch` to a
  branch Pages doesn't serve, such as `stats-data`, and deploy the `site-dir`
  output with `actions/upload-pages-artifact`.
- **A separate stats repo**: set `repo: owner/stats` and a `token` that can
  push there (a PAT or GitHub App token). Each source repo gets its own
  directory, `<owner>/<repo>/stats/` by default, so several repos can share
  one stats repo. `create-repo: true` creates it on first use.

## Inputs

| Input                                 | Default                 | Description                                                                        |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `tests`                               |                         | Result files or dirs to read in this job (globs, one per line). Single-job setups. |
| `test-format`                         | `auto`                  | Force `junit`, `ctrf` or `allure`.                                                 |
| `coverage`                            |                         | Coverage reports to read in this job (globs). Single-job setups.                   |
| `coverage-format`                     | `auto`                  | Force `lcov` or `cobertura`.                                                       |
| `flags`                               |                         | Labels for the results and coverage read in this job.                              |
| `components`                          | one per language        | `Name: glob, glob` per line. See [Coverage](#coverage).                            |
| `carryforward`                        | `false`                 | `true`, or the flags to carry forward when missing.                                |
| `patch-coverage`                      | `true`                  | Coverage of the changed lines, on PRs and pushes.                                  |
| `detail-window`                       | `50`                    | Runs whose line-level coverage is kept.                                            |
| `download-artifacts`                  | `true`                  | Merge in the `collect` uploads from this run.                                      |
| `repo`                                | this repo               | Repo holding the stats branch.                                                     |
| `branch`                              | `gh-pages`              | Stats branch.                                                                      |
| `path`                                | `stats`                 | Directory in the branch (`<owner>/<repo>/stats` in another repo).                  |
| `token`                               | `github.token`          | Token to read and push the stats branch.                                           |
| `record`                              | `auto`                  | `auto`, `always` or `never`. See above.                                            |
| `history-window`                      | `30`                    | Runs kept in the per-test history.                                                 |
| `viewer`                              | `true`                  | Copy the dashboard into the stats directory.                                       |
| `allow-public-pages-for-private-repo` | `false`                 | See [Privacy](#privacy).                                                           |
| `fail-on-test-failure`                | `false`                 | Fail this step if any test failed.                                                 |
| `push-attempts`                       | `6`                     | Push retries after losing a race.                                                  |
| `create-repo`, `repo-visibility`      | `false`, `public`       | Create a missing `repo`.                                                           |
| `commit-name`, `commit-email`         | `github-actions[bot]`   | Author of stats commits.                                                           |
| `commit-message`                      | repo, commit and run id | Commit message.                                                                    |
| `artifact-prefix`                     | `standalone-stats-`     | Must match `collect`'s.                                                            |

`collect` takes `tests` and/or `coverage` (globs), `test-format`,
`coverage-format`, `flags`, `id` (only if one job runs `collect` twice),
`if-no-files-found` (`warn`), `artifact-prefix` and `retention-days` (`7`).

## Outputs

| Output                                                         | Description                                         |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `site-url`                                                     | Dashboard URL.                                      |
| `badge-url`, `badge-markdown`                                  | Tests badge, and README Markdown for it.            |
| `site-dir`                                                     | Local copy of the stats directory (when recorded).  |
| `recorded`                                                     | `true` if this run was stored.                      |
| `run-key`                                                      | `<run id>-<attempt>`.                               |
| `tests-total`, `tests-passed`, `tests-failed`, `tests-skipped` | Counts, summed over jobs.                           |
| `new-failures`                                                 | Tests failing now that weren't in the baseline run. |
| `coverage-lines`, `coverage-branches`, `coverage-patch`        | Percent, two decimals; empty when there's none.     |
| `coverage-badge-url`, `coverage-badge-markdown`                | Coverage badge, and README Markdown for it.         |

## Roadmap

1. **PR comments**, including from forks (a `workflow_run` companion), and
   coverage thresholds.
2. **Dashboard**: compare two runs side by side; highlight a PR's changed lines
   in the per-line view.
3. More inputs: TRX, TAP, JaCoCo XML, Istanbul JSON, LLVM JSON.

## Development

```bash
bun install
bun run lint         # tsc --noEmit (action, dashboard, e2e)
bun run test         # unit + integration tests (uses local bare git repos)
bun run build        # bundles dist/ (committed: GitHub runs it directly)
bun run viewer:demo  # writes demo stats (real pipeline, seeded) to viewer/.demo
bun run viewer:dev   # dashboard dev server over viewer/.demo (or STATS_DIR)
bun run e2e          # Playwright, headless: built dashboard over the demo data
```

`dist/publish/main.js` (the action) and `dist/collect/main.js` share a chunk in
`dist/chunks/`. The dashboard (`viewer/`, React + Vite) builds into
`dist/viewer/` and imports the coverage model from `src/`, so it merges line
detail exactly the way publishing does. This repo's CI
runs both actions on itself, so the badge above is the action's own test run.
Design notes are in [`plans/design-recommendation.md`](plans/design-recommendation.md).

## See also

- [`benchmark-action/github-action-benchmark`](https://github.com/benchmark-action/github-action-benchmark):
  benchmark history on `gh-pages`. The push-retry approach here is modeled on it.
- [`py-cov-action/python-coverage-comment-action`](https://github.com/py-cov-action/python-coverage-comment-action):
  Python coverage with a data branch and the two-workflow fork pattern.
- [`EnricoMi/publish-unit-test-result-action`](https://github.com/EnricoMi/publish-unit-test-result-action)
  and [`dorny/test-reporter`](https://github.com/dorny/test-reporter): test
  results as check runs, without history.
- [CTRF](https://ctrf.io): a common JSON test report format with reporters for
  many frameworks.

Sister actions:

- [`cinderblock/github-action-working-directory`](https://github.com/cinderblock/github-action-working-directory):
  clone a branch, modify it, commit it back.
- [`cinderblock/github-action-debug-list-files`](https://github.com/cinderblock/github-action-debug-list-files):
  print the workspace tree at any point in a workflow.
