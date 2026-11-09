import {
  SCHEMA,
  STATUS_SEVERITY,
  addTest,
  emptyTotals,
  sumTotals,
  worse,
  type CommitInfo,
  type Failure,
  type RunInfo,
  type RunRecord,
  type TestStatus,
  type Upload,
} from '../model.js';

/** How many failures one run file keeps. The rest are counted, not listed. */
export const FAILURE_CAP = 200;

/** One test across every upload in the run. */
export interface MergedTest {
  id: string;
  suite: string;
  name: string;
  file?: string;
  /** Worst status across uploads. */
  status: TestStatus;
  /** Max duration across uploads. */
  durationMs: number;
  flaky: boolean;
  byUpload: Map<string, { status: TestStatus; message?: string }>;
}

export function mergeTests(uploads: Upload[]): Map<string, MergedTest> {
  const merged = new Map<string, MergedTest>();
  for (const u of uploads) {
    for (const t of u.tests) {
      let m = merged.get(t.id);
      if (!m) {
        m = {
          id: t.id,
          suite: t.suite,
          name: t.name,
          status: t.status,
          durationMs: t.durationMs,
          flaky: false,
          byUpload: new Map(),
        };
        if (t.file) m.file = t.file;
        merged.set(t.id, m);
      }
      m.status = worse(m.status, t.status);
      m.durationMs = Math.max(m.durationMs, t.durationMs);
      if (t.flaky) m.flaky = true;
      // The same id twice in one upload (parametrized tests without unique
      // names): keep the worse result.
      const prev = m.byUpload.get(u.key);
      if (!prev || STATUS_SEVERITY[t.status] > STATUS_SEVERITY[prev.status])
        m.byUpload.set(
          u.key,
          t.message
            ? { status: t.status, message: t.message }
            : { status: t.status },
        );
    }
  }
  return merged;
}

const isBad = (s: TestStatus) => s === 'failed' || s === 'errored';

export interface RecordContext {
  run: RunInfo;
  commit: CommitInfo;
  now?: Date;
}

export function buildRecord(
  uploads: Upload[],
  ctx: RecordContext,
): { record: RunRecord; tests: Map<string, MergedTest> } {
  const tests = mergeTests(uploads);
  let totals = emptyTotals();
  const summaries = uploads.map(u => {
    const t = emptyTotals();
    for (const tc of u.tests) addTest(t, tc);
    totals = sumTotals(totals, t);
    return {
      key: u.key,
      label: u.label,
      dims: u.dims,
      flags: u.flags,
      formats: [...new Set(u.sources.map(s => s.format))],
      tests: t,
    };
  });

  const failures: Failure[] = [];
  let failing = 0;
  for (const m of tests.values()) {
    if (!isBad(m.status)) continue;
    failing++;
    if (failures.length >= FAILURE_CAP) continue;
    const bad = [...m.byUpload].filter(([, r]) => isBad(r.status));
    const f: Failure = {
      id: m.id,
      suite: m.suite,
      name: m.name,
      status: m.status,
      uploads: bad.map(([k]) => k).sort(),
    };
    if (m.file) f.file = m.file;
    const message = bad.find(([, r]) => r.message)?.[1].message;
    if (message) f.message = message;
    failures.push(f);
  }
  failures.sort((a, b) => a.id.localeCompare(b.id));

  const record: RunRecord = {
    schema: SCHEMA,
    key: `${ctx.run.id}-${ctx.run.attempt}`,
    time: (ctx.now ?? new Date()).toISOString(),
    run: ctx.run,
    commit: ctx.commit,
    uploads: summaries,
    tests: {
      totals,
      unique: tests.size,
      flaky: [...tests.values()].filter(t => t.flaky).length,
      failures,
      failuresTruncated: failing > failures.length,
    },
  };
  return { record, tests };
}

export interface Comparison {
  baseKey: string;
  baseSha: string;
  /** Failing now, not failing (or absent) in the base. */
  newFailures: string[];
  /** Failing in the base, passing now. */
  fixed: string[];
  /** Failing in both. */
  stillFailing: string[];
  /** Current minus base. Failure sets come from the capped failure lists,
   *  so with more than FAILURE_CAP failures they're partial. */
  delta: { total: number; failed: number; durationMs: number };
}

export function compare(
  current: RunRecord,
  tests: Map<string, MergedTest>,
  base: RunRecord,
): Comparison {
  const baseFailing = new Set(base.tests.failures.map(f => f.id));
  const curFailing = new Set(current.tests.failures.map(f => f.id));
  const newFailures = [...curFailing].filter(id => !baseFailing.has(id)).sort();
  const stillFailing = [...curFailing].filter(id => baseFailing.has(id)).sort();
  const fixed = [...baseFailing]
    .filter(id => !curFailing.has(id) && tests.get(id)?.status === 'passed')
    .sort();
  const c = current.tests.totals;
  const b = base.tests.totals;
  return {
    baseKey: base.key,
    baseSha: base.commit.sha,
    newFailures,
    fixed,
    stillFailing,
    delta: {
      total: c.total - b.total,
      failed: c.failed + c.errored - (b.failed + b.errored),
      durationMs: c.durationMs - b.durationMs,
    },
  };
}
