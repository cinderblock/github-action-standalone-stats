import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gather, identity, parseMatrix } from '../src/collect/gather.js';
import {
  SCHEMA,
  type TestCase,
  type TestsIndex,
  type Upload,
} from '../src/model.js';
import { buildRecord, compare, FAILURE_CAP } from '../src/publish/merge.js';
import {
  applyRun,
  readBaseline,
  rebuildIndex,
  updateTestsIndex,
} from '../src/publish/store.js';
import { renderSummary } from '../src/publish/summary.js';
import { dedupe, validateUpload } from '../src/upload.js';
import { VERSION } from '../src/version.js';

const tc = (
  name: string,
  status: TestCase['status'],
  extra: Partial<TestCase> = {},
): TestCase => ({
  id: `s › ${name}`,
  suite: 's',
  name,
  status,
  durationMs: 10,
  ...extra,
});

function upload(
  label: string,
  tests: TestCase[],
  extra: Partial<Upload> = {},
): Upload {
  const id = identity('test', { os: label }, '');
  return {
    schema: SCHEMA,
    key: id.key,
    label: id.label,
    job: 'test',
    dims: id.dims,
    flags: [],
    attempt: 1,
    createdAt: '2026-11-07T00:00:00.000Z',
    sources: [{ format: 'junit', path: 'junit.xml', tests: tests.length }],
    tests,
    ...extra,
  };
}

const ctx = (
  id: number,
  sha = 'a'.repeat(40),
  time = '2026-11-07T10:00:00.000Z',
) => ({
  run: {
    id,
    attempt: 1,
    number: id,
    workflow: 'CI',
    url: `https://github.com/o/r/actions/runs/${id}`,
  },
  commit: { sha, ref: 'refs/heads/main', branch: 'main', event: 'push' },
  now: new Date(time),
});

describe('identity', () => {
  it('is stable regardless of matrix key order, and distinct per leg', () => {
    const a = identity(
      'test',
      parseMatrix('{"os":"ubuntu-latest","node":24}'),
      '',
    );
    const b = identity(
      'test',
      parseMatrix('{"node":24,"os":"ubuntu-latest"}'),
      '',
    );
    const c = identity(
      'test',
      parseMatrix('{"os":"windows-latest","node":24}'),
      '',
    );
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.label).toBe('test (24, ubuntu-latest)');
    expect(a.dims).toEqual({ node: '24', os: 'ubuntu-latest' });
  });
  it('treats no matrix as empty', () => {
    expect(parseMatrix('null')).toEqual({});
    expect(parseMatrix('')).toEqual({});
    expect(identity('build', {}, '', 'Linux').label).toBe('build');
    expect(identity('build', {}, '', 'Linux').dims).toEqual({
      'runner.os': 'Linux',
    });
  });
});

describe('gather', () => {
  it('reads globbed files into one upload with workspace-relative sources', async () => {
    const ws = join(import.meta.dir, 'fixtures', 'tests');
    const u = await gather({
      identity: identity('test', {}, ''),
      testPatterns: [join(ws, '*.xml')],
      flags: ['b', 'a', 'a'],
      workspace: ws,
      attempt: 2,
    });
    expect(u.sources.map(s => s.path)).toEqual([
      'bun-windows.xml',
      'gtest.xml',
      'pytest.xml',
      'surefire.xml',
    ]);
    expect(u.flags).toEqual(['a', 'b']);
    expect(u.tests.length).toBe(11 + 4 + 3 + 2);
    expect(validateUpload(JSON.parse(JSON.stringify(u)))).toEqual(u);
  });
});

describe('validateUpload', () => {
  it('rejects wrong schemas and malformed keys', () => {
    expect(() => validateUpload({ schema: 2, key: 'abcdef0123' })).toThrow(
      /schema/,
    );
    expect(() => validateUpload({ schema: 1, key: '../../etc' })).toThrow(
      /key/,
    );
  });
  it('coerces hostile fields into safe values', () => {
    const u = validateUpload({
      schema: 1,
      key: 'abcdef0123456789',
      label: 'x'.repeat(5000),
      tests: [
        {
          name: 'n',
          status: 'pwned',
          durationMs: -5,
          message: 'm',
          flaky: 'yes',
        },
      ],
    });
    expect(u.label.length).toBe(300);
    expect(u.tests[0]).toEqual({
      id: 'n',
      suite: '',
      name: 'n',
      status: 'other',
      durationMs: 0,
      message: 'm',
    });
  });
});

describe('dedupe', () => {
  it('keeps the highest attempt per key', () => {
    const a = upload('ubuntu', [tc('t', 'failed')]);
    const b = { ...a, attempt: 2, tests: [tc('t', 'passed')] };
    expect(dedupe([a, b])).toEqual([b]);
    expect(dedupe([b, a])).toEqual([b]);
  });
});

describe('buildRecord', () => {
  it('merges uploads: worst status per test, failures name their jobs', () => {
    const lin = upload('ubuntu', [
      tc('a', 'passed'),
      tc('b', 'failed', { message: 'boom' }),
      tc('c', 'skipped'),
    ]);
    const win = upload('windows', [
      tc('a', 'errored', { message: 'win' }),
      tc('b', 'passed'),
      tc('d', 'passed', { flaky: true }),
    ]);
    const { record, tests } = buildRecord([lin, win], ctx(1));
    expect(record.key).toBe('1-1');
    expect(record.tests.totals).toMatchObject({
      total: 6,
      passed: 3,
      failed: 1,
      errored: 1,
      skipped: 1,
    });
    expect(record.tests.unique).toBe(4);
    // Each test once, by its worst status: a errored, b failed, c skipped, d passed.
    expect(record.tests.byTest).toMatchObject({
      total: 4,
      passed: 1,
      failed: 1,
      errored: 1,
      skipped: 1,
    });
    expect(record.tests.flaky).toBe(1);
    expect(
      record.tests.failures.map(f => [f.name, f.status, f.uploads, f.message]),
    ).toEqual([
      ['a', 'errored', [win.key], 'win'],
      ['b', 'failed', [lin.key], 'boom'],
    ]);
    expect(tests.get('s › a')!.status).toBe('errored');
    expect(record.uploads.map(u => u.tests.total)).toEqual([3, 3]);
  });

  it('caps the stored failure list', () => {
    const many = Array.from({ length: FAILURE_CAP + 5 }, (_, i) =>
      tc(`t${i}`, 'failed'),
    );
    const { record } = buildRecord([upload('x', many)], ctx(1));
    expect(record.tests.failures).toHaveLength(FAILURE_CAP);
    expect(record.tests.failuresTruncated).toBe(true);
  });
});

describe('compare', () => {
  it('finds new, fixed and still-failing tests', () => {
    const base = buildRecord(
      [upload('x', [tc('a', 'failed'), tc('b', 'failed'), tc('c', 'passed')])],
      ctx(1),
    ).record;
    const { record, tests } = buildRecord(
      [upload('x', [tc('a', 'failed'), tc('b', 'passed'), tc('c', 'failed')])],
      ctx(2),
    );
    const cmp = compare(record, tests, base);
    expect(cmp.newFailures).toEqual(['s › c']);
    expect(cmp.fixed).toEqual(['s › b']);
    expect(cmp.stillFailing).toEqual(['s › a']);
    expect(cmp.delta.failed).toBe(0);
  });
});

describe('updateTestsIndex', () => {
  it('aligns history columns, replaces re-applied runs, and trims to the window', () => {
    const r1 = buildRecord(
      [upload('x', [tc('a', 'passed'), tc('b', 'failed')])],
      ctx(1),
    ).tests;
    const r2 = buildRecord([upload('x', [tc('a', 'failed')])], ctx(2)).tests;
    const r3 = buildRecord(
      [upload('x', [tc('a', 'passed'), tc('c', 'skipped')])],
      ctx(3),
    ).tests;
    let idx: TestsIndex | undefined;
    idx = updateTestsIndex(idx, '1-1', r1, 3);
    idx = updateTestsIndex(idx, '2-1', r2, 3);
    idx = updateTestsIndex(idx, '2-1', r2, 3); // re-applied after a lost push race
    idx = updateTestsIndex(idx, '3-1', r3, 3);
    expect(idx.runs).toEqual(['1-1', '2-1', '3-1']);
    expect(idx.tests['s › a']!.h).toBe('pfp');
    expect(idx.tests['s › b']!.h).toBe('f--');
    expect(idx.tests['s › c']!.h).toBe('--s');
    idx = updateTestsIndex(idx, '4-1', r2, 2);
    expect(idx.runs).toEqual(['3-1', '4-1']);
    expect(idx.tests['s › a']!.h).toBe('pf');
    expect(idx.tests['s › a']!.d).toEqual([10, 10]);
    // b has no results left in the window: dropped.
    expect(idx.tests['s › b']).toBeUndefined();
  });
});

describe('applyRun / readBaseline', () => {
  const opts = {
    repo: 'o/r',
    window: 30,
    generator: { name: 'g', version: '0' },
  };

  it('writes the run, index, tests history, meta and badge; idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sst-store-'));
    try {
      const a = buildRecord(
        [upload('x', [tc('a', 'passed')])],
        ctx(1, 'a'.repeat(40), '2026-10-31T23:00:00.000Z'),
      );
      const b = buildRecord(
        [upload('x', [tc('a', 'failed')])],
        ctx(2, 'b'.repeat(40), '2026-11-07T10:00:00.000Z'),
      );
      await applyRun(root, a.record, a.tests, opts);
      await applyRun(root, b.record, b.tests, opts);
      const index = await applyRun(root, b.record, b.tests, opts);
      expect(index.runs.map(r => [r.key, r.path])).toEqual([
        ['1-1', 'data/runs/2026/10/1-1.json'],
        ['2-1', 'data/runs/2026/11/2-1.json'],
      ]);
      expect(existsSync(join(root, 'data/runs/2026/11/2-1.json'))).toBe(true);
      const tests = JSON.parse(
        await readFile(join(root, 'data/tests.json'), 'utf8'),
      ) as TestsIndex;
      expect(tests.tests['s › a']!.h).toBe('pf');
      expect(await readFile(join(root, 'badges/tests.svg'), 'utf8')).toContain(
        '1 failing',
      );

      // A late publish of an older run must not roll the badge back.
      const late = buildRecord(
        [upload('x', [tc('a', 'passed')])],
        ctx(3, 'c'.repeat(40), '2026-11-01T00:00:00.000Z'),
      );
      await applyRun(root, late.record, late.tests, opts);
      expect(await readFile(join(root, 'badges/tests.svg'), 'utf8')).toContain(
        '1 failing',
      );

      expect((await rebuildIndex(root, 'o/r')).runs.map(r => r.key)).toEqual([
        '1-1',
        '3-1',
        '2-1',
      ]);

      const base = await readBaseline(root, 'o/r', 'main', 2);
      expect(base?.key).toBe('3-1');
      expect(await readBaseline(root, 'o/r', 'other')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderSummary', () => {
  it('summarizes totals, jobs, comparison and failures', () => {
    const base = buildRecord(
      [upload('ubuntu', [tc('a', 'passed')])],
      ctx(1),
    ).record;
    const { record, tests } = buildRecord(
      [
        upload('ubuntu', [
          tc('a', 'failed', { message: 'oops' }),
          tc('b|c', 'passed'),
        ]),
      ],
      ctx(2),
    );
    const md = renderSummary(record, compare(record, tests, base), {
      siteUrl: 'https://o.github.io/r/stats/',
      badgeUrl: 'https://o.github.io/r/stats/badges/tests.svg',
      recorded: false,
    });
    expect(md).toContain('❌ **1** passed · **1** failing');
    expect(md).toContain('**1 new failure**');
    expect(md).toContain('| test (ubuntu) | 1 | **1** | 0 |');
    expect(md).toContain('oops');
    expect(md).toContain('compared but not recorded');
  });
  it('says so when there were no results', () => {
    const { record } = buildRecord([], ctx(1));
    expect(renderSummary(record, undefined, { recorded: false })).toContain(
      'No test results',
    );
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
