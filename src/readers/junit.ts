import { testId, truncate, type TestCase, type TestStatus } from '../model.js';
import { relativize } from '../paths.js';
import {
  attr,
  children,
  parseXml,
  secondsToMs,
  text,
  type XmlNode,
} from './xml.js';

/**
 * JUnit XML, in the dialects that matter: Surefire/Gradle, jest-junit,
 * mocha-junit-reporter, pytest, gtest, ctest, `bun test --reporter=junit`,
 * `node --test-reporter=junit`, vitest. There is no single spec, so this is
 * lenient: nested `<testsuite>`s, `status` attributes, Surefire flaky
 * reruns.
 */

const ARRAYS = [
  'testsuite',
  'testcase',
  'failure',
  'error',
  'skipped',
  'flakyFailure',
  'flakyError',
  'rerunFailure',
  'rerunError',
];

/** Suite names that carry no information. */
const GENERIC_SUITES = new Set(['root suite', 'mocha tests', 'bun test', '']);

export function isJunit(xml: string): boolean {
  // Look past the prolog and comments for the root element.
  const m = /<(?!\?|!)([A-Za-z_][\w:.-]*)/.exec(xml);
  return m?.[1] === 'testsuites' || m?.[1] === 'testsuite';
}

export function readJunit(xml: string, workspace: string): TestCase[] {
  const doc = parseXml(xml, ARRAYS);
  const out: TestCase[] = [];
  const roots = doc.testsuites
    ? children(doc, 'testsuites').flatMap(r => children(r, 'testsuite'))
    : children(doc, 'testsuite');

  // Some writers put <testcase> directly under <testsuites>.
  for (const r of children(doc, 'testsuites'))
    for (const tc of children(r, 'testcase'))
      out.push(toCase(tc, [], undefined, workspace));

  const walk = (suite: XmlNode, path: string[], inheritedFile?: string) => {
    const file =
      attr(suite, 'file') ?? attr(suite, 'filepath') ?? inheritedFile;
    let name = attr(suite, 'name') ?? '';
    // bun names the per-file suite after the file (with OS separators).
    if (file && name === file) name = relativize(file, workspace);
    const here = GENERIC_SUITES.has(name.toLowerCase())
      ? path
      : [...path, name];
    for (const tc of children(suite, 'testcase'))
      out.push(toCase(tc, here, file, workspace));
    for (const s of children(suite, 'testsuite')) walk(s, here, file);
  };
  for (const s of roots) walk(s, []);
  return out;
}

function toCase(
  tc: XmlNode,
  path: string[],
  suiteFile: string | undefined,
  workspace: string,
): TestCase {
  const name = attr(tc, 'name') ?? '(unnamed)';
  const classname = attr(tc, 'classname') ?? '';
  const segs = [...path];
  if (classname && segs[segs.length - 1] !== classname) segs.push(classname);
  const suite = segs.join(' › ');

  const rawFile = attr(tc, 'file') ?? suiteFile;
  const file = rawFile ? relativize(rawFile, workspace) : undefined;

  const failures = children(tc, 'failure');
  const errors = children(tc, 'error');
  const skipped = children(tc, 'skipped');
  const flakes = [
    ...children(tc, 'flakyFailure'),
    ...children(tc, 'flakyError'),
  ];
  const status = statusOf(tc, failures.length, errors.length, skipped.length);

  const problem =
    errors[0] ?? failures[0] ?? (status === 'skipped' ? skipped[0] : undefined);
  const message =
    status === 'passed'
      ? undefined
      : truncate(
          [attr(problem, 'message'), text(problem)].filter(Boolean).join('\n'),
        );

  const out: TestCase = {
    id: testId(suite, name),
    suite,
    name,
    status,
    durationMs: secondsToMs(attr(tc, 'time')),
  };
  if (file) out.file = file;
  if (message) out.message = message;
  if (status === 'passed' && flakes.length) out.flaky = true;
  return out;
}

function statusOf(
  tc: XmlNode,
  failures: number,
  errors: number,
  skipped: number,
): TestStatus {
  if (errors) return 'errored';
  if (failures) return 'failed';
  if (skipped) return 'skipped';
  // gtest/ctest put the outcome in attributes instead.
  const s = (attr(tc, 'status') ?? '').toLowerCase();
  const result = (attr(tc, 'result') ?? '').toLowerCase();
  if (['notrun', 'disabled', 'skipped', 'ignored'].includes(s))
    return 'skipped';
  if (['suppressed', 'skipped'].includes(result)) return 'skipped';
  if (['fail', 'failed', 'failure'].includes(s)) return 'failed';
  if (s === 'error') return 'errored';
  return 'passed';
}
