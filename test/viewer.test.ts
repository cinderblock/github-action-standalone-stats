import { describe, expect, it } from 'bun:test';
import { encodeCoverage, type Coverage } from '../src/coverage/model.js';
import { SCHEMA, type DetailFile, type IndexEntry } from '../src/model.js';
import {
  detailFlags,
  lineViews,
  listDir,
  mergeDetail,
  missRanges,
  totalsByFile,
} from '../viewer/src/lib/coverage.js';
import { fmtDelta, fmtPct, pctOf } from '../viewer/src/lib/format.js';
import { href } from '../viewer/src/lib/router.js';
import {
  branchParam,
  mainBranch,
  previousOnBranch,
  seriesNames,
} from '../viewer/src/lib/runs.js';
import { flips, median, sortTests, testRows } from '../viewer/src/lib/tests.js';

const cov = (files: Record<string, [number, number, string?][]>): Coverage =>
  new Map(
    Object.entries(files).map(([p, lines]) => [
      p,
      new Map(lines.map(([n, hits, br]) => [n, br ? { hits, br } : { hits }])),
    ]),
  );

const detail: DetailFile = {
  schema: SCHEMA,
  key: '1-1',
  sha: 'a'.repeat(40),
  groups: [
    {
      flags: ['Linux'],
      files: encodeCoverage(
        cov({
          'src/a.ts': [
            [1, 1],
            [2, 0],
          ],
        }),
      ),
    },
    {
      flags: ['Windows'],
      files: encodeCoverage(
        cov({ 'src/a.ts': [[2, 3]], 'src/b/c.ts': [[5, 0, '10']] }),
      ),
    },
  ],
};

describe('viewer coverage', () => {
  it('merges detail groups, optionally by flag', () => {
    expect(detailFlags(detail)).toEqual(['Linux', 'Windows']);
    const all = mergeDetail(detail);
    expect(all.get('src/a.ts')!.get(2)!.hits).toBe(3);
    const linux = mergeDetail(detail, ['Linux']);
    expect(linux.get('src/a.ts')!.get(2)!.hits).toBe(0);
    expect(linux.has('src/b/c.ts')).toBe(false);
  });

  it('lists a directory with totals, collapsing single-dir chains', () => {
    const c = mergeDetail(detail);
    const byFile = totalsByFile(c);
    const root = listDir(c, byFile, '');
    expect(root.map(e => [e.name, e.dir])).toEqual([['src', true]]);
    expect(root[0]!.totals.lines).toEqual({ hit: 2, total: 3 });
    const src = listDir(c, byFile, 'src');
    expect(src.map(e => e.name)).toEqual(['b', 'a.ts']);
    const deep = cov({ 'a/b/c/d.ts': [[1, 1]], 'x.ts': [[1, 0]] });
    expect(listDir(deep, totalsByFile(deep), '').map(e => e.name)).toEqual([
      'a/b/c',
      'x.ts',
    ]);
  });

  it('classifies lines and finds missed ranges', () => {
    const f = cov({
      f: [
        [1, 1],
        [2, 0],
        [4, 0],
        [5, 2, '10'],
        [7, -1, '11'],
        [9, 1],
      ],
    }).get('f')!;
    const lines = lineViews(f, 10);
    expect(lines).toHaveLength(10);
    expect(lines.map(l => l.state)).toEqual([
      'hit',
      'miss',
      'none',
      'miss',
      'partial',
      'none',
      'hit',
      'none',
      'hit',
      'none',
    ]);
    expect(lines[4]!.br).toEqual([1, 2]);
    expect(lines[6]!.hits).toBeUndefined();
    // Line 3 isn't coverable, so 2–4 is one range.
    expect(missRanges(lines)).toEqual([[2, 4]]);
    expect(missRanges(lines, ['miss', 'partial'])).toEqual([[2, 5]]);
  });
});

describe('viewer tests', () => {
  it('counts flips across skips and gaps', () => {
    expect(flips('ppfpp')).toBe(2);
    expect(flips('p-s-f')).toBe(1);
    expect(flips('fe')).toBe(0);
    expect(median([5, -1, 1, 3])).toBe(3);
    expect(median([])).toBe(0);
  });

  it('builds rows and sorts by failing, flaky and slow', () => {
    const rows = testRows({
      schema: SCHEMA,
      runs: ['1', '2', '3'],
      tests: {
        a: { suite: 's', name: 'a', h: 'ppp', d: [1, 1, 1] },
        b: { suite: 's', name: 'b', h: 'pfp', d: [5, 5, 5] },
        c: { suite: 's', name: 'c', h: 'pp-', d: [9, 9, -1] },
        d: { suite: 's', name: 'd', h: 'ppf', d: [2, 2, 2] },
      },
    });
    const c = rows.find(r => r.id === 'c')!;
    expect([c.last, c.runs, c.lastMs]).toEqual(['p', 2, 9]);
    expect(sortTests(rows, 'failing')[0]!.id).toBe('d');
    expect(sortTests(rows, 'flaky')[0]!.id).toBe('b');
    expect(sortTests(rows, 'slow')[0]!.id).toBe('c');
  });
});

describe('viewer runs', () => {
  const e = (
    key: string,
    branch: string,
    event = 'push',
    f?: Record<string, [number, number]>,
  ) =>
    ({
      key,
      branch,
      event,
      time: `2026-11-0${key}T00:00:00Z`,
      ...(f ? { coverage: { l: [1, 2], b: [0, 0], f } } : {}),
    }) as unknown as IndexEntry;
  const runs = [
    e('1', 'main'),
    e('2', 'feat', 'pull_request', { Win: [1, 2] }),
    e('3', 'main', 'push', { Linux: [1, 2], Win: [1, 2] }),
    e('4', 'feat', 'pull_request'),
    e('5', 'main'),
  ];
  it('picks the main branch and the previous run', () => {
    expect(mainBranch(runs)).toBe('main');
    expect(previousOnBranch(runs, '5')!.key).toBe('3');
    expect(previousOnBranch(runs, '1')).toBeUndefined();
    expect(seriesNames(runs, 'f')).toEqual(['Linux', 'Win']);
  });
  it('reads the branch query', () => {
    expect(branchParam(new URLSearchParams(''), 'main')).toBe('main');
    expect(branchParam(new URLSearchParams('branch=all'), 'main')).toBe('');
    expect(branchParam(new URLSearchParams('branch=feat'), 'main')).toBe(
      'feat',
    );
  });
});

describe('viewer format and routes', () => {
  it('floors percentages and signs deltas', () => {
    expect(fmtPct(pctOf([9999, 10000]), 1)).toBe('99.9%');
    expect(fmtPct(pctOf([0, 0]))).toBe('n/a');
    expect(fmtDelta(80, 79.5)).toBe('+0.50');
    expect(fmtDelta(79, 80)).toBe('−1.00');
    expect(fmtDelta(80, 80)).toBe('±0');
  });
  it('encodes segments and drops empty query values', () => {
    expect(
      href(['coverage', '1-1', 'file', 'src/a b.ts'], { flags: '', path: 'x' }),
    ).toBe('#/coverage/1-1/file/src/a%20b.ts?path=x');
    expect(href(['test'], { id: 'suite › a/b' })).toBe(
      '#/test?id=suite+%E2%80%BA+a%2Fb',
    );
  });
});
