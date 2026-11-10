/**
 * The standalone-stats data model.
 *
 * Two layers:
 *  - **Upload**: what one `collect` step produces (one CI job, one matrix
 *    leg). Paths are already normalized against that job's workspace.
 *  - **Stored data** on the stats branch: per-run records plus derived
 *    indexes the viewer reads. Everything is plain JSON and versioned by
 *    `schema`, so the viewer can refuse data it doesn't understand.
 */

import type { CoverageSource } from './coverage/read.js';
import type { CoverageFileData, CovTotals, Ratio } from './coverage/model.js';
import type { PatchFile } from './coverage/patch.js';

export const SCHEMA = 1;

export type TestStatus = 'passed' | 'failed' | 'errored' | 'skipped' | 'other';

/** Worst-first ordering, used to combine results of the same test. */
export const STATUS_SEVERITY: Record<TestStatus, number> = {
  errored: 4,
  failed: 3,
  other: 2,
  passed: 1,
  skipped: 0,
};

/** One-character codes used in the compact per-test history. */
export const STATUS_CODE: Record<TestStatus, string> = {
  passed: 'p',
  failed: 'f',
  errored: 'e',
  skipped: 's',
  other: 'o',
};

export interface TestCase {
  /** Stable identity: `<suite> › <name>`. Same test, same id, every run. */
  id: string;
  suite: string;
  name: string;
  /** Repo-relative, forward slashes, when the reporter recorded it. */
  file?: string;
  status: TestStatus;
  durationMs: number;
  /** Passed only after a retry (reporters that record retries). */
  flaky?: boolean;
  /** Failure message, truncated. Only kept for non-passing tests. */
  message?: string;
}

export interface TestTotals {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  other: number;
  durationMs: number;
}

export type TestFormat = 'junit' | 'ctrf' | 'allure';
export const TEST_FORMAT_LIST: readonly TestFormat[] = [
  'junit',
  'ctrf',
  'allure',
];

export interface SourceFile {
  format: TestFormat;
  /** Workspace-relative path of the input file (or directory, for Allure). */
  path: string;
  tests: number;
}

/** Output of one `collect` step. */
export interface Upload {
  schema: typeof SCHEMA;
  /** Stable identity of the producing job: job id + matrix + optional id. */
  key: string;
  /** Human label, e.g. `test (ubuntu-latest, 24)`. */
  label: string;
  job: string;
  /** Matrix values of the producing job, stringified, plus `runner.os`. */
  dims: Record<string, string>;
  flags: string[];
  attempt: number;
  createdAt: string;
  sources: SourceFile[];
  tests: TestCase[];
  /** Coverage read in this job, paths already workspace-relative. */
  coverage?: {
    sources: CoverageSource[];
    files: CoverageFileData[];
  };
}

export interface CommitInfo {
  sha: string;
  ref: string;
  branch?: string;
  event: string;
  pr?: number;
}

export interface RunInfo {
  id: number;
  attempt: number;
  number: number;
  workflow: string;
  url: string;
}

export interface UploadSummary {
  key: string;
  label: string;
  dims: Record<string, string>;
  flags: string[];
  formats: TestFormat[];
  tests: TestTotals;
  coverage?: CovTotals;
}

export interface Failure {
  id: string;
  suite: string;
  name: string;
  file?: string;
  status: TestStatus;
  /** Upload keys where it didn't pass. */
  uploads: string[];
  message?: string;
}

/** One stored run: `data/runs/<yyyy>/<mm>/<runId>-<attempt>.json`. */
export interface RunRecord {
  schema: typeof SCHEMA;
  key: string;
  time: string;
  run: RunInfo;
  commit: CommitInfo;
  uploads: UploadSummary[];
  tests: {
    /** Sum over every upload (a test on 3 OSes counts 3 times). */
    totals: TestTotals;
    /** Distinct test ids. */
    unique: number;
    /** One count per distinct test, by its worst status across uploads (a
     *  test failing on one OS counts once, as failing). Absent before 2026-11. */
    byTest?: TestTotals;
    flaky: number;
    failures: Failure[];
    /** True if `failures` was capped. */
    failuresTruncated: boolean;
  };
  coverage?: RunCoverage;
}

export interface RunCoverage {
  /** Every session merged, carried-forward ones included. */
  totals: CovTotals;
  flags: Record<string, CovTotals & { carried?: true }>;
  components: Record<string, CovTotals>;
  /** Flags whose coverage came from the baseline, not this run. */
  carriedForward: string[];
  patch?: Ratio & {
    base: string;
    partial: boolean;
    /** Worst first, capped. */
    files: PatchFile[];
  };
  /** Line detail, relative to the stats dir. Pruned for old runs. */
  detail: string;
}

/** `data/detail/<runKey>.json`: line-level coverage, grouped by flag set. */
export interface DetailFile {
  schema: typeof SCHEMA;
  key: string;
  sha: string;
  groups: { flags: string[]; files: CoverageFileData[] }[];
}

/** `[hit, total]`, compact for the index. */
export type Pair = [number, number];

export interface IndexCoverage {
  l: Pair;
  b: Pair;
  c?: Record<string, Pair>;
  f?: Record<string, Pair>;
  p?: Pair;
}

/** One row per stored run in `data/index.json`. */
export interface IndexEntry {
  key: string;
  time: string;
  sha: string;
  branch?: string;
  event: string;
  url: string;
  tests: TestTotals;
  unique: number;
  /** See `RunRecord.tests.byTest`. */
  byTest?: TestTotals;
  flaky: number;
  path: string;
  coverage?: IndexCoverage;
}

export interface IndexFile {
  schema: typeof SCHEMA;
  repo: string;
  updated: string;
  runs: IndexEntry[];
}

/** `data/tests.json`: rolling per-test history for flaky/slow analysis. */
export interface TestsIndex {
  schema: typeof SCHEMA;
  /** Run keys, oldest first. Each test's `h` aligns to this list. */
  runs: string[];
  tests: Record<
    string,
    {
      suite: string;
      name: string;
      file?: string;
      /** One char per run: status code (worst across uploads), '-' if absent. */
      h: string;
      /** Per run: max duration across uploads in ms, or -1 if absent. */
      d: number[];
    }
  >;
}

export function emptyTotals(): TestTotals {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    skipped: 0,
    other: 0,
    durationMs: 0,
  };
}

export function addTest(t: TestTotals, tc: TestCase): void {
  t.total++;
  t[tc.status]++;
  t.durationMs += tc.durationMs;
}

export function sumTotals(a: TestTotals, b: TestTotals): TestTotals {
  return {
    total: a.total + b.total,
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    errored: a.errored + b.errored,
    skipped: a.skipped + b.skipped,
    other: a.other + b.other,
    durationMs: a.durationMs + b.durationMs,
  };
}

export function worse(a: TestStatus, b: TestStatus): TestStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

export function testId(suite: string, name: string): string {
  return suite ? `${suite} › ${name}` : name;
}

export const MESSAGE_LIMIT = 2000;

export function truncate(s: string | undefined, limit = MESSAGE_LIMIT) {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}
