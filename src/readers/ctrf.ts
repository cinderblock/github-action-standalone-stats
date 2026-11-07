import { testId, truncate, type TestCase, type TestStatus } from '../model.js';
import { relativize } from '../paths.js';

/**
 * CTRF (Common Test Report Format, https://ctrf.io) JSON. Reporters exist for
 * jest, mocha, vitest, playwright, cypress, pytest, Go, .NET, Rust and more.
 * Spec is pre-1.0, so read defensively: `suite` is a string in older reports
 * and an array in newer ones.
 */

interface CtrfTest {
  name?: unknown;
  status?: unknown;
  duration?: unknown;
  suite?: unknown;
  message?: unknown;
  trace?: unknown;
  filePath?: unknown;
  flaky?: unknown;
}

export function isCtrf(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const results = (json as { results?: { tests?: unknown } }).results;
  return !!results && Array.isArray(results.tests);
}

const STATUS: Record<string, TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'skipped',
  other: 'other',
};

export function readCtrf(json: unknown, workspace: string): TestCase[] {
  if (!isCtrf(json))
    throw new Error('Not a CTRF report (no results.tests array)');
  const tests = (json as { results: { tests: CtrfTest[] } }).results.tests;
  return tests.map(t => {
    const name = typeof t.name === 'string' && t.name ? t.name : '(unnamed)';
    const suite = Array.isArray(t.suite)
      ? t.suite.map(String).join(' › ')
      : typeof t.suite === 'string'
        ? t.suite.split(/\s*>\s*/).join(' › ')
        : '';
    const status = STATUS[String(t.status).toLowerCase()] ?? 'other';
    const duration = Number(t.duration);
    const out: TestCase = {
      id: testId(suite, name),
      suite,
      name,
      status,
      durationMs:
        Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    };
    if (typeof t.filePath === 'string' && t.filePath)
      out.file = relativize(t.filePath, workspace);
    if (status !== 'passed') {
      const message = truncate(
        [t.message, t.trace].filter(x => typeof x === 'string' && x).join('\n'),
      );
      if (message) out.message = message;
    }
    if (status === 'passed' && t.flaky === true) out.flaky = true;
    return out;
  });
}
