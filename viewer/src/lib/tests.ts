import type { TestsIndex } from '../../../src/model.js';

export type HistoryCode = 'p' | 'f' | 'e' | 's' | 'o' | '-';

export interface TestRow {
  id: string;
  suite: string;
  name: string;
  file?: string;
  h: string;
  d: number[];
  /** Status in the newest run it appeared in. */
  last: HistoryCode;
  runs: number;
  fails: number;
  /** Pass↔fail transitions, ignoring skips and absences. */
  flips: number;
  /** Duration in the newest run it ran in, ms. */
  lastMs: number;
  medianMs: number;
}

const bad = (c: string) => c === 'f' || c === 'e';

export function flips(h: string): number {
  let n = 0;
  let prev: boolean | undefined;
  for (const c of h) {
    if (c === '-' || c === 's') continue;
    const isBad = bad(c);
    if (prev !== undefined && prev !== isBad) n++;
    prev = isBad;
  }
  return n;
}

export function median(xs: number[]): number {
  const v = xs.filter(x => x >= 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export function testRows(idx: TestsIndex): TestRow[] {
  return Object.entries(idx.tests).map(([id, t]) => {
    let last: HistoryCode = '-';
    let lastMs = 0;
    for (let i = t.h.length - 1; i >= 0; i--)
      if (t.h[i] !== '-') {
        last = t.h[i] as HistoryCode;
        lastMs = Math.max(0, t.d[i] ?? 0);
        break;
      }
    const ran = t.h.replace(/-/g, '');
    const row: TestRow = {
      id,
      suite: t.suite,
      name: t.name,
      h: t.h,
      d: t.d,
      last,
      runs: ran.length,
      fails: [...ran].filter(bad).length,
      flips: flips(t.h),
      lastMs,
      medianMs: median(t.d),
    };
    if (t.file) row.file = t.file;
    return row;
  });
}

export type TestSort = 'flaky' | 'failing' | 'slow' | 'name';

export function sortTests(rows: TestRow[], by: TestSort): TestRow[] {
  const cmp: Record<TestSort, (a: TestRow, b: TestRow) => number> = {
    flaky: (a, b) => b.flips - a.flips || b.fails - a.fails,
    failing: (a, b) =>
      Number(bad(b.last)) - Number(bad(a.last)) || b.fails - a.fails,
    slow: (a, b) => b.medianMs - a.medianMs,
    name: () => 0,
  };
  return [...rows].sort((a, b) => cmp[by](a, b) || a.id.localeCompare(b.id));
}

export const STATUS_LABEL: Record<HistoryCode, string> = {
  p: 'passed',
  f: 'failed',
  e: 'errored',
  s: 'skipped',
  o: 'other',
  '-': 'not run',
};
