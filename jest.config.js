module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js'],
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  coverage: true,
  collectCoverageFrom: ['src/**/*.ts'],
  testRegex: '(/tests/[^/]+)\\.ts$',
  verbose: true,
  reporters: [
    'default',
    [
      'jest-stare',
      {
        resultDir: 'public/jest-stare',
        reportTitle: 'jest-stare!',
        coverageLink: '../coverage/lcov-report/index.html',
        jestStareConfigJson: 'jest-stare.json',
        jestGlobalConfigJson: 'globalStuff.json',
      },
    ],
  ],
  coverageDirectory: 'public/coverage',
};
