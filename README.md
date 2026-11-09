# Standalone Stats

Self-hosted test stats for GitHub Actions: merge results from every job in a
run (a whole OS × version matrix), keep history on a branch of your own repo,
and publish a dashboard and README badges with GitHub Pages. **No third-party
service**, no extra secrets, no Java.

Code coverage (lcov and Cobertura, merged across the matrix, with per-component
and per-flag breakdowns) is the next milestone. See [Roadmap](#roadmap).

[![CI](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml)
[![tests](https://cinderblock.github.io/github-action-standalone-stats/stats/badges/tests.svg)](https://cinderblock.github.io/github-action-standalone-stats/stats/)

> **Status:** pre-release. There are no tags yet, so pin a commit SHA if you
> try it before `v1` is published.

## What it does

- Reads **JUnit XML**, **CTRF JSON** and **Allure 2 results**, detected
  automatically. That covers bun, node:test, jest, vitest, mocha, pytest,
  gtest, ctest, Surefire/Gradle, Go, .NET, Playwright and more, with each
  framework's own reporter.
- In a matrix, each job runs a small `collect` step. One fan-in `publish` job
  merges them all, so jobs never race each other to push.
- Stores each run as a small JSON file on a branch (default `gh-pages`, under
  `stats/`), plus indexes the dashboard reads. No raw report dumps.
- Pull requests get a **job summary** comparing against the target branch:
  new failures, fixed tests, per-job counts. That works for fork PRs too,
  because it doesn't need write access.
- Publishes a dashboard (trend, latest failures, flaky tests, recent runs) and
  an SVG badge.

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
      - run: npx jest --ci --reporters=default --reporters=jest-junit

      - name: Publish stats
        if: ${{ !cancelled() }} # publish failures too
        uses: cinderblock/github-action-standalone-stats@<sha>
        with:
          tests: junit.xml
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
      - run: npm test -- --reporter mocha-junit-reporter
      - uses: cinderblock/github-action-standalone-stats/collect@<sha>
        if: ${{ !cancelled() }}
        with:
          tests: test-results.xml

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

## Where things live

Default: branch `gh-pages`, directory `stats/`. It sits next to whatever else
your Pages site serves.

```
stats/
  index.html                       dashboard
  badges/tests.svg
  data/meta.json                   schema version, generator
  data/index.json                  one row per stored run (charts, run list)
  data/tests.json                  per-test history for the last N runs (flaky/slow)
  data/runs/YYYY/MM/<run>-<attempt>.json   one file per stored run
```

A run file is a few KB: totals, per-job counts, and the failing tests with
their messages (passing tests aren't listed individually there). Note that
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

| Input                                 | Default                 | Description                                                                         |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `tests`                               |                         | Result files or dirs to read in this job (globs, one per line). Single-job setups. |
| `test-format`                         | `auto`                  | Force `junit`, `ctrf` or `allure`.                                                  |
| `flags`                               |                         | Labels for the results read via `tests`.                                            |
| `download-artifacts`                  | `true`                  | Merge in the `collect` uploads from this run.                                       |
| `repo`                                | this repo               | Repo holding the stats branch.                                                      |
| `branch`                              | `gh-pages`              | Stats branch.                                                                       |
| `path`                                | `stats`                 | Directory in the branch (`<owner>/<repo>/stats` in another repo).                   |
| `token`                               | `github.token`          | Token to read and push the stats branch.                                            |
| `record`                              | `auto`                  | `auto`, `always` or `never`. See above.                                             |
| `history-window`                      | `30`                    | Runs kept in the per-test history.                                                  |
| `viewer`                              | `true`                  | Copy the dashboard into the stats directory.                                        |
| `allow-public-pages-for-private-repo` | `false`                 | See [Privacy](#privacy).                                                            |
| `fail-on-test-failure`                | `false`                 | Fail this step if any test failed.                                                  |
| `push-attempts`                       | `6`                     | Push retries after losing a race.                                                   |
| `create-repo`, `repo-visibility`      | `false`, `public`       | Create a missing `repo`.                                                            |
| `commit-name`, `commit-email`         | `github-actions[bot]`   | Author of stats commits.                                                            |
| `commit-message`                      | repo, commit and run id | Commit message.                                                                     |
| `artifact-prefix`                     | `standalone-stats-`     | Must match `collect`'s.                                                             |

`collect` takes `tests` (required), `test-format`, `flags`, `id` (only if one
job runs `collect` twice), `if-no-files-found` (`warn`), `artifact-prefix` and
`retention-days` (`7`).

## Outputs

| Output                                                      | Description                                         |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `site-url`                                                  | Dashboard URL.                                      |
| `badge-url`, `badge-markdown`                               | Tests badge, and README Markdown for it.            |
| `site-dir`                                                  | Local copy of the stats directory (when recorded).  |
| `recorded`                                                  | `true` if this run was stored.                      |
| `run-key`                                                   | `<run id>-<attempt>`.                               |
| `tests-total`, `tests-passed`, `tests-failed`, `tests-skipped` | Counts, summed over jobs.                        |
| `new-failures`                                              | Tests failing now that weren't in the baseline run. |

## Roadmap

1. **Coverage.** lcov and Cobertura (gcovr, OpenCppCoverage, coverage.py,
   JaCoCo), merged across the matrix the way Codecov merges uploads: flags per
   upload, components by path (one per language by default), carryforward,
   patch coverage on PRs, coverage badges.
2. **A real dashboard.** Coverage tree and per-line view, trends per flag and
   component, test history, run comparison.
3. **PR comments**, including from forks (a `workflow_run` companion), and
   thresholds.
4. More inputs: TRX, TAP, Istanbul JSON, LLVM JSON.

## Development

```bash
bun install
bun run lint     # tsc --noEmit
bun test         # unit + integration tests (uses local bare git repos)
bun run build    # bundles dist/ (committed: GitHub runs it directly)
```

`dist/publish/main.js` (the action) and `dist/collect/main.js` share a chunk in
`dist/chunks/`, and the dashboard is copied to `dist/viewer/`. This repo's CI
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
