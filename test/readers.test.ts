import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAllure } from '../src/readers/allure.js';
import { readCtrf } from '../src/readers/ctrf.js';
import { readTestPaths } from '../src/readers/index.js';
import { isJunit, readJunit } from '../src/readers/junit.js';

const fx = (f: string) => join(import.meta.dir, 'fixtures', 'tests', f);
const read = (f: string) => readFile(fx(f), 'utf8');

describe('JUnit', () => {
  it('detects the root element past the prolog', () => {
    expect(isJunit('<?xml version="1.0"?>\n<!-- hi -->\n<testsuites>')).toBe(
      true,
    );
    expect(isJunit('<coverage line-rate="1">')).toBe(false);
  });

  it('reads bun output on Windows with OS-independent ids', async () => {
    const tests = readJunit(await read('bun-windows.xml'), 'C:\\work\\repo');
    expect(tests).toHaveLength(11);
    const t = tests[0]!;
    // The per-file suite is named with backslashes by bun; the id must not be.
    expect(t.suite).toBe('src/inputs.test.ts › readInputs');
    expect(t.id).toBe(
      'src/inputs.test.ts › readInputs › applies defaults and resolves same-repo mode from GITHUB_REPOSITORY',
    );
    expect(t.file).toBe('src/inputs.test.ts');
    expect(t.status).toBe('passed');
    expect(t.durationMs).toBe(0);
  });

  it('reads gtest statuses, failures and odd time formats', async () => {
    const tests = readJunit(
      await read('gtest.xml'),
      '/home/runner/work/lib/lib',
    );
    const by = Object.fromEntries(tests.map(t => [t.name, t]));
    expect(by.Empty!.status).toBe('passed');
    expect(by.Known!.status).toBe('failed');
    expect(by.Known!.message).toContain('Expected equality');
    expect(by.Known!.file).toBe('test/crc8.cpp');
    expect(by.DISABLED_Slow!.status).toBe('skipped');
    expect(by.Large!.durationMs).toBe(1234500);
    expect(by.Empty!.suite).toBe('Crc8');
  });

  it('reads pytest errors and skips, ignoring the generic suite name', async () => {
    const tests = readJunit(await read('pytest.xml'), '/w');
    expect(tests.map(t => t.status)).toEqual(['passed', 'errored', 'skipped']);
    expect(tests[0]!.suite).toBe('pytest › tests.test_io');
    expect(tests[1]!.message).toContain("fixture 'tmp' not found");
    expect(tests[2]!.message).toContain('not windows');
  });

  it('marks Surefire flaky reruns as flaky passes', async () => {
    const tests = readJunit(await read('surefire.xml'), '/w');
    expect(tests[0]!.status).toBe('passed');
    expect(tests[0]!.flaky).toBe(true);
    expect(tests[0]!.message).toBeUndefined();
    expect(tests[1]!.flaky).toBeUndefined();
  });

  it('keeps messages short', () => {
    const big = 'x'.repeat(10_000);
    const [t] = readJunit(
      `<testsuite><testcase name="a"><failure message="${big}"/></testcase></testsuite>`,
      '/',
    );
    expect(t!.message!.length).toBeLessThan(2100);
  });
});

describe('CTRF', () => {
  it('maps statuses, suites (string and array) and paths', async () => {
    const tests = readCtrf(
      JSON.parse(await read('ctrf.json')),
      '/home/runner/work/app/app',
    );
    expect(tests.map(t => t.status)).toEqual([
      'passed',
      'failed',
      'passed',
      'skipped',
    ]);
    expect(tests[0]!.suite).toBe('math › add');
    expect(tests[0]!.file).toBe('src/math.test.ts');
    expect(tests[1]!.suite).toBe('math › sub');
    expect(tests[1]!.message).toContain('Expected 1');
    expect(tests[1]!.message).toContain('at sub');
    expect(tests[2]!.flaky).toBe(true);
  });
  it('rejects non-CTRF JSON', () => {
    expect(() => readCtrf({ foo: 1 }, '/')).toThrow();
  });
});

describe('Allure', () => {
  it('collapses retries to the newest result and flags flaky passes', () => {
    const tests = readAllure([
      { historyId: 'h', name: 'a', status: 'failed', start: 0, stop: 1 },
      { historyId: 'h', name: 'a', status: 'passed', start: 5, stop: 6 },
    ]);
    expect(tests).toHaveLength(1);
    expect(tests[0]!.status).toBe('passed');
    expect(tests[0]!.flaky).toBe(true);
    expect(tests[0]!.durationMs).toBe(1);
  });
});

describe('readTestPaths', () => {
  it('detects every format, and groups Allure files by directory', async () => {
    const paths = [
      'bun-windows.xml',
      'gtest.xml',
      'ctrf.json',
      'allure-results',
    ].map(fx);
    const results = await readTestPaths(paths, '/w');
    expect(results.map(r => r.format).sort()).toEqual([
      'allure',
      'ctrf',
      'junit',
      'junit',
    ]);
    const allure = results.find(r => r.format === 'allure')!;
    expect(allure.tests).toHaveLength(2);
    const login = allure.tests.find(t => t.name === 'logs in')!;
    expect(login.suite).toBe('e2e › auth');
    expect(login.flaky).toBe(true);
    const sums = allure.tests.find(t => t.name.startsWith('sums'))!;
    expect(sums.name).toBe('sums [n=1]');
    expect(sums.status).toBe('errored');

    // Matching the individual files gives the same answer as the directory.
    const files = ['a1-result.json', 'a2-result.json', 'b1-result.json'].map(
      f => fx(`allure-results/${f}`),
    );
    const again = await readTestPaths(files, '/w');
    expect(again).toHaveLength(1);
    expect(again[0]!.tests).toHaveLength(2);
  });

  it('strips a BOM and explains unknown files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sst-readers-'));
    try {
      await writeFile(
        join(dir, 'bom.xml'),
        '\uFEFF<testsuite><testcase name="a"/></testsuite>',
      );
      await writeFile(join(dir, 'junk.txt'), 'hello');
      await writeFile(join(dir, 'other.json'), '{"a":1}');
      expect(
        (await readTestPaths([join(dir, 'bom.xml')], dir))[0]!.tests,
      ).toHaveLength(1);
      await expect(readTestPaths([join(dir, 'junk.txt')], dir)).rejects.toThrow(
        /can't detect/,
      );
      await expect(
        readTestPaths([join(dir, 'other.json')], dir),
      ).rejects.toThrow(/not CTRF/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
