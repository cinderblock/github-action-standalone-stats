import { testId, truncate, type TestCase, type TestStatus } from '../model.js';

/**
 * Allure 2 results directory (`allure-results/*-result.json`), as written by
 * allure-js, allure-pytest, allure-java and friends. Only results are read;
 * containers, attachments and history are ignored.
 *
 * One test can have several result files (retries). They're grouped by
 * `historyId` (falling back to `testCaseId`/`fullName`); the newest wins and
 * a pass after an earlier failure counts as flaky.
 */

interface AllureResult {
  uuid?: string;
  name?: string;
  fullName?: string;
  historyId?: string;
  testCaseId?: string;
  status?: string;
  statusDetails?: { message?: string; trace?: string; flaky?: boolean };
  start?: number;
  stop?: number;
  labels?: { name?: string; value?: string }[];
  parameters?: { name?: string; value?: string; excluded?: boolean }[];
}

const STATUS: Record<string, TestStatus> = {
  passed: 'passed',
  failed: 'failed',
  broken: 'errored',
  skipped: 'skipped',
  unknown: 'other',
};

export function isAllureResult(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const r = json as AllureResult;
  return (
    typeof r.status === 'string' &&
    (typeof r.historyId === 'string' ||
      typeof r.fullName === 'string' ||
      typeof r.uuid === 'string')
  );
}

export function readAllure(results: unknown[]): TestCase[] {
  const groups = new Map<string, AllureResult[]>();
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as AllureResult;
    const key = r.historyId ?? r.testCaseId ?? r.fullName ?? r.name;
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const out: TestCase[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.stop ?? a.start ?? 0) - (b.stop ?? b.start ?? 0));
    const r = group[group.length - 1]!;
    const status = STATUS[(r.status ?? '').toLowerCase()] ?? 'other';
    const labels = new Map<string, string>();
    for (const l of r.labels ?? [])
      if (l.name && l.value && !labels.has(l.name)) labels.set(l.name, l.value);

    const suiteParts = ['parentSuite', 'suite', 'subSuite']
      .map(n => labels.get(n))
      .filter((x): x is string => !!x);
    if (!suiteParts.length) {
      const cls = labels.get('testClass') ?? labels.get('package');
      if (cls) suiteParts.push(cls);
    }
    const params = (r.parameters ?? [])
      .filter(p => !p.excluded && p.name)
      .map(p => `${p.name}=${p.value ?? ''}`);
    const baseName = r.name ?? r.fullName ?? '(unnamed)';
    const name = params.length
      ? `${baseName} [${params.join(', ')}]`
      : baseName;
    const suite = suiteParts.join(' › ');

    const durationMs =
      r.start !== undefined && r.stop !== undefined && r.stop >= r.start
        ? r.stop - r.start
        : 0;
    const tc: TestCase = {
      id: testId(suite, name),
      suite,
      name,
      status,
      durationMs,
    };
    if (status !== 'passed') {
      const message = truncate(
        [r.statusDetails?.message, r.statusDetails?.trace]
          .filter(Boolean)
          .join('\n'),
      );
      if (message) tc.message = message;
    } else if (
      r.statusDetails?.flaky ||
      group
        .slice(0, -1)
        .some(x => x.status !== 'passed' && x.status !== 'skipped')
    ) {
      tc.flaky = true;
    }
    out.push(tc);
  }
  return out;
}
