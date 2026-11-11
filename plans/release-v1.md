# Release v1: the three `github-action-*` repos as a set

## Goal

Tag and release `v1.0.0` (plus a moving `v1` tag) on all three actions together, as Cameron
asked when the tags were first held: "released as a coherent set". Nothing is tagged until
Cameron says yes to this exact plan.

## Status: released 2026-11-10, ~4:30 PM PST (~00:30Z Nov 11)

Cameron approved the whole plan ("Yes, all of it") and the rename of debug-list-files' old `v1`
branch.

- [x] [PR #28](https://github.com/cinderblock/github-action-standalone-stats/pull/28) merged: `fast-xml-parser` 5.12.0. Dependabot alert 128 closed.
- [x] Sibling PRs merged.
  - [debug-list-files #24](https://github.com/cinderblock/github-action-debug-list-files/pull/24)
    (`b47d307`) fixed:
    - **the diff never printed**: lists were keyed by `GITHUB_ACTION`, which differs per step;
    - dotfiles are listed;
    - the default filter is anchored;
    - CI checks the diff.
  - [working-directory #24](https://github.com/cinderblock/github-action-working-directory/pull/24)
    (`c4c9e1f`) fixed:
    - **any clone failure silently started an empty orphan branch**;
    - `repo` accepts `owner/name`;
    - `working-directory` is required;
    - a full round-trip CI test.
  - Both READMEs rewritten.
- [x] [PR #29](https://github.com/cinderblock/github-action-standalone-stats/pull/29) merged (`866904c`):
  - README `@v1`;
  - "±0 pts";
  - "no coverable lines changed".
- [x] debug-list-files' 2020 `v1` **branch** (node12) renamed to `archive/v1-2020`, so `@v1` isn't
      ambiguous. working-directory's 2020 `v0` branch was left alone; it doesn't clash.
- [x] Annotated `v1.0.0` plus lightweight `v1` tags on each master tip, and GitHub releases:
  - [working-directory](https://github.com/cinderblock/github-action-working-directory/releases/tag/v1.0.0)
  - [debug-list-files](https://github.com/cinderblock/github-action-debug-list-files/releases/tag/v1.0.0)
  - [standalone-stats](https://github.com/cinderblock/github-action-standalone-stats/releases/tag/v1.0.0)
- [x] Verified by run 42931499392 on a throwaway `check-v1` branch, deleted afterwards:
  - every `@v1` resolved to the release commit;
  - the debug-list-files diff printed;
  - `collect@v1` + publish `@v1` counted 2 passed;
  - working-directory `@v1` cloned `gh-pages`.
- Not done (not asked): Marketplace listing.

## Findings

- **Old deployment branches can shadow version tags.** debug-list-files had a `v1` branch from a
  2020 "Automated deployment" workflow. Check for `v*` branches before tagging.
- Git Bash rewrites env values that contain `/` (MSYS path conversion), so a local test of a regex
  `INPUT_FILTER` saw `C:/Program Files/Git/` inside the value. Use `MSYS_NO_PATHCONV=1` and a
  Windows path for local action runs.

## Readiness (checked 2026-11-10, ~4:10 PM PST (~00:10Z Nov 11))

All three repos have no tags, no releases and no open PRs except the one listed below.

### `github-action-standalone-stats` (this repo)

- master `8cfa15b` plus a plan commit. All 7 CI jobs green. Phases 1–4 merged.
- [PR #28](https://github.com/cinderblock/github-action-standalone-stats/pull/28): bumps
  `fast-xml-parser` 5.11.2 → 5.12.0, which fixes the only open Dependabot alert (#128, low).
  Needs a merge.
- README usage examples say `@<sha>`. Switch them to `@v1` in the release commit. The
  companion example already says `comment@v1`.

### `github-action-debug-list-files`

- master `6755541` (Nov 6): ESM bundle fix, node24, CI self-test. CI green. `package.json`
  1.0.0. 0 open alerts.
- README is stale:
  - the status badge points at a `Main` workflow, which is now `CI`;
  - "Other Reporters" links to 2020 jest-stare, jest-html and Allure reports on its gh-pages.
    They still load but are frozen in 2020.

### `github-action-working-directory`

- master `20cd73e` (Nov 6): ESM bundles fix, node24, checkout v7. CI green. `package.json`
  1.0.0. 0 open alerts.
- README is stale:
  - "Test with self" links to `.github/workflows/main.yml`, which no longer exists (it's
    `ci.yml`);
  - "Test Reports" shows 2020 Allure, jest-stare, jest-html and lcov reports, frozen the same
    way.

## Proposed steps (each needs Cameron's yes as a whole)

1. Merge PR #28.
2. One small README PR per sibling:
   - fix the badge and workflow link to `CI` / `ci.yml`;
   - drop the frozen 2020 report links, or label them as an archive.
     Merge both once green.
3. This repo: a commit switching the README's `@<sha>` to `@v1`.
4. On each repo's master tip, in this order: working-directory, debug-list-files,
   standalone-stats.
   - an annotated tag `v1.0.0`;
   - a lightweight moving tag `v1` on the same commit;
   - a GitHub release `v1.0.0` with the notes below.
   - Marketplace listing is a checkbox in the release UI. Not touched unless Cameron asks.
5. Verify: a workflow in this repo uses `cinderblock/github-action-standalone-stats@v1` and
   `/collect@v1` once, and passes.

## Draft release notes

### standalone-stats v1.0.0

Self-hosted test and coverage stats for GitHub Actions, with no third-party service.

- **Tests:** reads JUnit XML, CTRF JSON and Allure 2 results. Results are merged across a
  matrix with `collect` in each job and one publish step. Each test is counted once on the
  badge.
- **Coverage:** reads lcov and Cobertura. Merged Codecov-style, with flags, components,
  carryforward and patch coverage.
- **History:** stored as compact JSON on a branch of your repo (default `gh-pages/stats/`).
  Pushes retry safely when runs race.
- **Dashboard:** a static React app on GitHub Pages. Pages for runs, tests (flaky and slow),
  coverage trends, a file tree and per-line coverage.
- **Badges:** tests, coverage, and one per component and flag.
- **Pull requests:**
  - a job summary;
  - a sticky PR comment;
  - optional coverage thresholds as commit statuses (`standalone-stats/coverage`,
    `standalone-stats/patch`);
  - fork PRs are covered by the `comment` companion action from a `workflow_run` workflow.
- Runs on node24. Three actions in one repo: the root (publish), `collect` and `comment`.

### debug-list-files v1.0.0

List the files in a working directory on the runner, and diff them against an earlier call.
It's meant for debugging workflows.

- Inputs: `name`, `working-directory`, `search` glob, `filter`.
- The first release since 2020:
  - rewritten on Bun with a committed ESM bundle, on node24;
  - `filter` and the diff output now work (both were no-ops);
  - CI runs the action on itself.

### working-directory v1.0.0

Clone a branch (of this repo or another) into a working directory, change it during the job,
and commit and push the changes back in the post step.

- Inputs: `branch`, `repo`, `working-directory`, `commit-message`, `commit-name`,
  `commit-email`, `commit-unchanged`.
- The first release since 2020:
  - rewritten on Bun with committed ESM bundles, on node24;
  - fixed shell quoting leaking into git config values;
  - fixed a broken error chain;
  - `commit-unchanged` now works.

## Things not to do

- Don't tag anything before Cameron's yes on this plan.
- Don't publish to the Marketplace unasked.
- Don't move a `v1` tag later without saying so. Moving it is the normal way to ship a v1.x
  release, but it changes what every user runs.
