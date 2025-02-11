import AllureReporter from 'allure-vitest/reporter';
import { defineConfig } from 'vitest/config';
import type { ResolvedConfig } from 'vitest/node';

const reporters: ResolvedConfig['reporters'][number][] = [];

reporters.push(['default', {}]);
reporters.push(['verbose', {}]);

reporters.push([
  'html',
  {
    outputFile: 'public/vitest/index.html',
  },
]);

reporters.push([
  'jest-html-reporter',
  {
    pageTitle: 'Test Report',
    outputPath: 'public/jest-html-reporter.html',
  },
]);

reporters.push([
  'jest-stare',
  {
    pageTitle: 'Test Report',
    resultDir: 'public/jest-stare',
  },
]);

reporters.push([
  'allure-vitest/reporter',
  {
    resultsDir: 'public/allure-report',
  },
]);

if (process.env.GITHUB_ACTIONS) {
  reporters.push(['github-actions', {}]);
}

export default defineConfig({
  test: {
    setupFiles: ['allure-vitest/setup'],
    reporters,
    globals: true,
    coverage: {
      include: ['src/**/*.ts'],
    },
    include: ['tests/**/*.ts'],
  },
});
