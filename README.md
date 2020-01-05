## GitHub Badge

Normally, we're restricted to simple badges like this.

[![cinderblock/github-action-standalone-stats status](https://github.com/cinderblock/github-action-standalone-stats/workflows/Main/badge.svg?branch=master)](https://github.com/cinderblock/github-action-standalone-stats/actions?query=branch%3Amaster)

## Standalone Stats

Standalone Stats gives you stats like this.

[![This is where the magic is gonna be](https://cinderblock.github.io/github-action-standalone-stats/dashboard.svg)](https://cinderblock.github.io/github-action-standalone-stats)

## How It Works

Inspired by tools like [coveralls.io](https://coveralls.io), this tool takes raw coverage report files (`lcov` format) and generates pretty graphs to show coverage over time.
Instead of relying on a 3rd party service to host these generated static reports, we generate them ourselves and use github-pages to host the various files.

It is helpful, for generating reports, to have the raw historical data for each execution.
We use an extra branch on GitHub (or, optionally, a separate repo) to store this historical data and use it to generate new reports on push.

## Usage

In your GitHub Actions, add a config like this:

```yml
jobs:
  self-test-and-generate-stats:
    runs-on: ubuntu-latest # Anything should work
    steps:
      - name: Checkout your code
        uses: actions/checkout@v1

      - name: Setup your code and run tests that generate reports
        run: |
          npm install
          npm test

      - name: Generate Standalone Stats
        uses: cinderblock/github-action-standalone-stats
        # This step will copy coverage reports (and others) to the specified historical branch
        # and use it to generate some pretty charts
        with:
          stats-branch: build-stats
          stats-repo: '' # Current
          pages-dir: public/action-stats

      # Publish to gh-pages
      - name: Publish to gh-pages
        uses: peaceiris/actions-gh-pages@v2
        env:
          # ACTIONS_DEPLOY_KEY: ${{ secrets.ACTIONS_DEPLOY_KEY }}
          # PERSONAL_TOKEN: ${{ secrets.PERSONAL_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PUBLISH_BRANCH: gh-pages
          PUBLISH_DIR: public
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
