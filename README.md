# Standalone Stats

Publish [Allure](https://allurereport.org/) test reports to a parallel branch
of your repo for self-contained pretty charts, trend graphs, and a README
badge — with **no third-party service** required.

[![CI](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/github-action-standalone-stats/actions/workflows/ci.yml)

## What it does

When you add this action to a workflow that runs Allure-emitting tests, it:

1. Clones the cumulative `allure-results/` from a side branch of your repo
   (creating it if it doesn't exist yet)
2. Merges in this run's fresh results
3. Runs `allure generate` to produce the HTML report, with trend graphs that
   span every run
4. Pushes the updated raw results back to the data branch (preserving
   `history/` for next run)
5. Pushes the rendered HTML to your `gh-pages` branch (or wherever GitHub
   Pages reads from)
6. Emits a `pages-url` output and a ready-to-paste Markdown badge snippet

The end result: `https://<owner>.github.io/<repo>/` serves the report, and a
badge in your README shows pass/fail at a glance.

## Quick start

```yml
name: Test
on: [push, pull_request]

permissions:
  contents: write # required so the action can push to the side branches

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Install
        run: npm install

      - name: Test (emits allure-results/)
        run: npm test
        continue-on-error: true # still publish stats even on test failure

      - name: Publish stats
        if: always() # publish on success AND failure
        uses: cinderblock/github-action-standalone-stats@v1
```

Then in your README:

```md
[![Allure Report](https://<owner>.github.io/<repo>/badge.svg)](https://<owner>.github.io/<repo>/)
```

The exact markdown snippet is also published as the `badge-markdown` output,
and shown in the Actions run summary, so you can copy-paste from there.

### Enable GitHub Pages

After the first successful run, go to **Settings → Pages** and set the source
to **branch: `gh-pages`, folder: `/ (root)`**. From then on, every workflow run
republishes the report to the same URL.

## Architecture

By default, the action writes to **two parallel orphan branches** in the same
repo:

| Branch        | Purpose                                               |
| ------------- | ----------------------------------------------------- |
| `allure-data` | Accumulated `allure-results/` + `history/` for trends |
| `gh-pages`    | Rendered HTML report (served by GitHub Pages)         |

Both are orphan branches with no history shared with `master`/`main`, so they
don't show up in `git log` for your code and they don't bloat clones of your
main branch.

### Optional: sibling repos

If you'd rather not have the stats branches on your main repo (e.g. to keep
the main repo's branch list clean, or to make the stats public while the code
stays private), set `data-repo` and/or `pages-repo`:

```yml
- uses: cinderblock/github-action-standalone-stats@v1
  with:
    data-repo: cinderblock/myproject-stats
    pages-repo: cinderblock/myproject-stats # can be the same as data-repo
    token: ${{ secrets.STATS_PAT }} # PAT with `repo` scope
```

If the sibling repo doesn't exist yet, the action creates it on first run
(see `auto-create-sibling-repos`). The PAT requirement is unavoidable here:
the workflow's default `GITHUB_TOKEN` cannot create or write to repos outside
the current workflow's repo.

## Inputs

| Input                       | Default                           | Description                                            |
| --------------------------- | --------------------------------- | ------------------------------------------------------ |
| `data-branch`               | `allure-data`                     | Branch storing cumulative `allure-results/`.           |
| `data-repo`                 | `''` (current)                    | Repo to store results in (`owner/name`).               |
| `data-path`                 | `''` (root)                       | Subdir of data-branch where results live.              |
| `pages-branch`              | `gh-pages`                        | Branch GitHub Pages reads from.                        |
| `pages-repo`                | `''` (current)                    | Repo to publish rendered report to.                    |
| `pages-path`                | `''` (root)                       | Subdir of pages-branch to write the report into.       |
| `results-dir`               | `allure-results`                  | Where the consumer's tests emit fresh results.         |
| `token`                     | `${{ github.token }}`             | Token for git pushes and (sibling mode) repo creation. |
| `commit-name`               | `github-actions[bot]`             | Git `user.name` for stats commits.                     |
| `commit-email`              | `41898282+github-actions[bot]@…`  | Git `user.email` for stats commits.                    |
| `commit-message`            | `standalone-stats: publish run …` | Commit message used on both branches.                  |
| `allure-version`            | `2.30.0`                          | Pinned `allure-commandline` version.                   |
| `auto-create-sibling-repos` | `true`                            | Create missing sibling repos via REST API.             |
| `sibling-repo-visibility`   | `public`                          | `public` or `private` for auto-created siblings.       |

## Outputs

| Output             | Description                                    |
| ------------------ | ---------------------------------------------- |
| `pages-url`        | URL where the rendered report is served.       |
| `badge-markdown`   | Pre-built Markdown snippet for your README.    |
| `data-branch-ref`  | Full ref of the data branch that was updated.  |
| `pages-branch-ref` | Full ref of the pages branch that was updated. |

## Requirements

- The workflow must have `permissions: contents: write` (and `pages: write`
  if you want the action to enable Pages on a sibling repo).
- A test runner that emits Allure results (e.g. `jest` with
  `jest-allure`, `mocha` with `mocha-allure-reporter`, `vitest` with
  `vitest-allure`, JUnit XML through `allure-junit`, etc.).
- The runner image needs Java (allure-commandline is a Java app). All
  GitHub-hosted runners include Java 11+; self-hosted runners may need to
  add `actions/setup-java@v4`.

## How history works

Allure's trend graphs require last run's `allure-report/history/` to be
present in this run's `allure-results/history/` before `allure generate` is
called. This action handles that automatically:

1. Clone the cumulative `allure-results/` from the data branch — this already
   contains `history/` from last run
2. Layer this run's fresh result JSON files on top
3. Run `allure generate`
4. Copy the freshly written `allure-report/history/` back into the data
   branch's `allure-results/history/`
5. Commit + push the data branch

So as long as you let the action manage the data branch end-to-end, trends
just work.

## Roadmap

v1.0.0 is Allure-only. Likely v1.1+:

- lcov coverage reports
- `jest-stare` and `jest-html-reporters` static HTML
- Per-run archives at `runs/<run_id>/<attempt>/`
- Retention / pruning policy for old results

## Development

```bash
bun install
bun run lint        # tsc --noEmit
bun test src        # unit + integration tests
bun run build       # bundles dist/index.js
```

The bundled `dist/index.js` is committed, because GitHub Actions executes it
directly without a build step. CI verifies the source compiles but doesn't
enforce a byte-for-byte match on `dist/` — bun bundler output varies slightly
across bun versions.
