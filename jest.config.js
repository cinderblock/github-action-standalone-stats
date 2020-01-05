module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js'],
  testEnvironment: 'node',
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  collectCoverageFrom: ['src/**/*.ts'],
  testRegex: '(/tests/[^/]+)\\.ts$',
  verbose: true
}
