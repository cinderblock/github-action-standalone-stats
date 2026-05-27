import { describe, it, expect } from 'bun:test';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSummary,
  renderBadgeSvg,
  writeBadge,
  hasResults,
  preserveHistory,
} from './allure.js';

async function makeTmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('readSummary', () => {
  it('returns zeros when summary.json is missing', async () => {
    const tmp = await makeTmp('sst-test-');
    const s = await readSummary(tmp);
    expect(s.total).toBe(0);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });

  it('reads statistics from widgets/summary.json', async () => {
    const tmp = await makeTmp('sst-test-');
    await mkdir(join(tmp, 'widgets'), { recursive: true });
    await writeFile(
      join(tmp, 'widgets', 'summary.json'),
      JSON.stringify({
        statistic: {
          total: 10,
          passed: 7,
          failed: 2,
          broken: 0,
          skipped: 1,
          unknown: 0,
        },
      }),
    );
    const s = await readSummary(tmp);
    expect(s.total).toBe(10);
    expect(s.passed).toBe(7);
    expect(s.failed).toBe(2);
    expect(s.skipped).toBe(1);
  });
});

describe('renderBadgeSvg', () => {
  const empty = {
    total: 0,
    passed: 0,
    failed: 0,
    broken: 0,
    skipped: 0,
    unknown: 0,
  };

  it('says "no tests" with grey when there are none', () => {
    const svg = renderBadgeSvg(empty);
    expect(svg).toContain('no tests');
    expect(svg).toContain('#9f9f9f');
  });

  it('says "N passing" with green when all pass', () => {
    const svg = renderBadgeSvg({ ...empty, total: 5, passed: 5 });
    expect(svg).toContain('5 passing');
    expect(svg).toContain('#4c1');
  });

  it('says "N failing" with red when any fail', () => {
    const svg = renderBadgeSvg({
      ...empty,
      total: 5,
      passed: 3,
      failed: 1,
      broken: 1,
    });
    expect(svg).toContain('2 failing');
    expect(svg).toContain('#e05d44');
  });
});

describe('writeBadge', () => {
  it('writes a badge.svg file into the output directory', async () => {
    const reportDir = await makeTmp('sst-test-report-');
    const outDir = await makeTmp('sst-test-out-');
    await writeBadge(reportDir, outDir);
    const svg = await readFile(join(outDir, 'badge.svg'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('no tests');
  });
});

describe('hasResults', () => {
  it('returns false for a missing directory', async () => {
    expect(await hasResults('/definitely/does/not/exist/xyz123')).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    const tmp = await makeTmp('sst-test-');
    expect(await hasResults(tmp)).toBe(false);
  });

  it('returns true when at least one *-result.json is present', async () => {
    const tmp = await makeTmp('sst-test-');
    await writeFile(join(tmp, 'abcd-result.json'), '{}');
    expect(await hasResults(tmp)).toBe(true);
  });

  it('returns true when at least one *-container.json is present', async () => {
    const tmp = await makeTmp('sst-test-');
    await writeFile(join(tmp, 'abcd-container.json'), '{}');
    expect(await hasResults(tmp)).toBe(true);
  });
});

describe('preserveHistory', () => {
  it('copies report/history into results/history', async () => {
    const report = await makeTmp('sst-report-');
    const results = await makeTmp('sst-results-');
    await mkdir(join(report, 'history'), { recursive: true });
    await writeFile(join(report, 'history', 'history.json'), '{}');

    await preserveHistory(report, results);

    const copied = await readFile(
      join(results, 'history', 'history.json'),
      'utf8',
    );
    expect(copied).toBe('{}');
  });

  it('no-ops when no history exists yet', async () => {
    const report = await makeTmp('sst-report-');
    const results = await makeTmp('sst-results-');
    await preserveHistory(report, results); // must not throw
  });
});
