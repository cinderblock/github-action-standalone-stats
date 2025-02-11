Normally, we're restricted to simple badges like this:
[![cinderblock/github-action-standalone-stats status](https://github.com/cinderblock/github-action-standalone-stats/workflows/Main/badge.svg?branch=master)](https://github.com/cinderblock/github-action-standalone-stats/actions?query=branch%3Amaster)
_(GitHub Action Badge)_

## Standalone Stats

![Github Action Standalone Stats](banner.svg)

[![Click for Full Build Report Metrics](https://cinderblock.github.io/github-action-standalone-stats/dashboard.svg)](https://cinderblock.github.io/github-action-standalone-stats)

### Other Reporters

- Test Reports:
  - [jest-stare](https://cinderblock.github.io/github-action-standalone-stats/jest-stare)
  - [jest-html-reporters](https://cinderblock.github.io/github-action-standalone-stats/jest-html-reporter.html)
  - [allure](https://cinderblock.github.io/github-action-standalone-stats/allure-report)
- Coverage Report:
  - [lcov](https://cinderblock.github.io/github-action-standalone-stats/coverage/lcov-report)

## How It Works

Inspired by tools like [coveralls.io](https://coveralls.io), this tool takes raw coverage report files (`lcov` format) and generates pretty graphs to show coverage over time.
However, instead of relying on a 3rd party service to host these generated static reports, we generate them ourselves and use github-pages to host the various generated static html files.

It is helpful, for generating reports, to have the raw historical data for each execution.
We use an extra branch on GitHub (or, optionally, a separate repo) to store this historical data and use it to generate new reports on push.
Git is the database.

## Usage

# ⚠️⚠️ WORK IN PROGRESS ⚠️⚠️ Not ready for use yet

In your GitHub Actions, add a config like this:

```yml
jobs:
  self-test-and-generate-stats:
    runs-on: ubuntu-latest # Anything should work
    steps:
      - name: Checkout your code
        uses: actions/checkout@v1

      - name: Setup your code
        run: npm install

      - name: Run your tests that generate reports
        id: tests
        run: npm test

      - name: Generate Standalone Stats
        # Run even if tests failed
        if: success() || steps.tests.result == 'failure'
        id: generateStats
        uses: cinderblock/github-action-standalone-stats@v1
        # This step will copy coverage reports (and others) to the specified historical branch
        # and use them all to generate some updated pretty charts
        with:
          stats-branch: build-stats
          stats-repo: '' # Current
          # Output directory for the generated reports
          pages-dir: public/action-stats

      # Publish to gh-pages
      - name: Publish to gh-pages
        # Run even if other steps failed, as long as generateStats succeeded
        if: success() || steps.generateStats.result == 'success'
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: public
```

Add this to your README

```md
[![Development Stats](https://<user>.github.io/<repo>/action-stats/<ref>/dashboard.svg)](https://<user>.github.io/<repo>/action-stats)
```

## Development

Install the dependencies

```bash
npm install
```

Build the typescript (automatic with `npm install`)

```bash
npm run build
```

Run the tests :heavy_check_mark:

```bash
npm test

 PASS  ./main.js
  ✓ throws invalid number (3ms)
  ✓ wait 500 ms (504ms)
  ✓ test runs (95ms)

...
```
