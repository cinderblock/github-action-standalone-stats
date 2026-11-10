/**
 * The PR report: what a comment and the commit statuses are made from.
 *
 * Publish builds one per run. With write access it posts it directly;
 * otherwise (fork PRs, read-only tokens) it uploads it as an artifact for
 * the `comment` companion action, which runs from `workflow_run` with
 * write access. That artifact is attacker-controlled on fork PRs, so
 * `sanitizeReport` rebuilds it field by field: numbers are numbers, strings
 * are capped, links are restricted, and nothing in it is ever executed.
 */
import type {
  Failure,
  RunCoverage,
  RunRecord,
  TestStatus,
  TestTotals,
  UploadSummary,
} from './model.js';
import { SCHEMA, STATUS_SEVERITY } from './model.js';
import { formatPct, type CovTotals, type Ratio } from './coverage/model.js';
import type { Comparison } from './publish/merge.js';
import {
  breakdown,
  code,
  deltaPct,
  fence,
  formatDuration,
  md,
  missedFiles,
} from './publish/summary.js';
import {
  evaluate,
  failedRules,
  type Rule,
  type RuleResult,
} from './thresholds.js';

export const REPORT_ARTIFACT = 'standalone-stats-report';
export const REPORT_FILE = 'report.json';
export const REPORT_KIND = 'standalone-stats-report';
/** GitHub rejects comments over 65,536 characters. */
const COMMENT_MAX = 60_000;
const MAX_REPORT_BYTES = 5_000_000;

/** The parts of a run record the comment uses. */
export interface ReportRun {
  key: string;
  sha: string;
  uploads: Pick<UploadSummary, 'key' | 'label' | 'tests' | 'coverage'>[];
  tests: Pick<
    RunRecord['tests'],
    'totals' | 'unique' | 'byTest' | 'flaky' | 'failures' | 'failuresTruncated'
  >;
  coverage?: RunCoverage;
}

export interface ReportComparison {
  baseKey: string;
  baseSha: string;
  newFailures: string[];
  fixed: string[];
  stillFailing: string[];
  delta: { total: number; failed: number; durationMs: number };
  baseCoverage?: RunCoverage;
}

export interface Report {
  kind: typeof REPORT_KIND;
  schema: typeof SCHEMA;
  /** Workflow name, for the comment marker (one comment per workflow). */
  workflow: string;
  runId: number;
  attempt: number;
  runUrl: string;
  /** PR number, when the run was for a pull request. */
  pr?: number;
  run: ReportRun;
  comparison?: ReportComparison;
  siteUrl?: string;
  recorded: boolean;
  note?: string;
  /** Thresholds the producing run was configured with. */
  rules: Rule[];
  /** What's left for the companion to do. */
  wants: { comment: boolean; statuses: boolean };
}

export function buildReport(args: {
  record: RunRecord;
  cmp: Comparison | undefined;
  workflow: string;
  runUrl: string;
  pr?: number;
  siteUrl?: string;
  recorded: boolean;
  note?: string;
  rules: Rule[];
  wants: Report['wants'];
}): Report {
  const { record, cmp } = args;
  const run: ReportRun = {
    key: record.key,
    sha: record.commit.sha,
    uploads: record.uploads.map(u => {
      const s: ReportRun['uploads'][number] = {
        key: u.key,
        label: u.label,
        tests: u.tests,
      };
      if (u.coverage) s.coverage = u.coverage;
      return s;
    }),
    tests: {
      totals: record.tests.totals,
      unique: record.tests.unique,
      flaky: record.tests.flaky,
      failures: record.tests.failures,
      failuresTruncated: record.tests.failuresTruncated,
      ...(record.tests.byTest ? { byTest: record.tests.byTest } : {}),
    },
    ...(record.coverage ? { coverage: record.coverage } : {}),
  };
  const r: Report = {
    kind: REPORT_KIND,
    schema: SCHEMA,
    workflow: args.workflow,
    runId: record.run.id,
    attempt: record.run.attempt,
    runUrl: args.runUrl,
    run,
    recorded: args.recorded,
    rules: args.rules,
    wants: args.wants,
  };
  if (args.pr) r.pr = args.pr;
  if (args.siteUrl) r.siteUrl = args.siteUrl;
  if (args.note) r.note = args.note;
  if (cmp) {
    r.comparison = {
      baseKey: cmp.baseKey,
      baseSha: cmp.baseSha,
      newFailures: cmp.newFailures,
      fixed: cmp.fixed,
      stillFailing: cmp.stillFailing,
      delta: cmp.delta,
      ...(cmp.coverage?.baseRun.coverage
        ? { baseCoverage: cmp.coverage.baseRun.coverage }
        : {}),
    };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Validation of an untrusted report.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];
const str = (v: unknown, max = 500): string =>
  typeof v === 'string' ? v.slice(0, max) : '';
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
const signedInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const sha = (v: unknown): string => {
  const s = str(v, 64);
  return /^[0-9a-f]{7,64}$/i.test(s) ? s : '';
};

function totals(v: unknown): TestTotals {
  const o = obj(v);
  return {
    total: int(o.total),
    passed: int(o.passed),
    failed: int(o.failed),
    errored: int(o.errored),
    skipped: int(o.skipped),
    other: int(o.other),
    durationMs: int(o.durationMs),
  };
}

function ratio(v: unknown): Ratio {
  const o = obj(v);
  const total = int(o.total);
  return { hit: Math.min(int(o.hit), total), total };
}

function covTotals(v: unknown): CovTotals {
  const o = obj(v);
  return {
    files: int(o.files),
    lines: ratio(o.lines),
    branches: ratio(o.branches),
  };
}

function named<T>(
  v: unknown,
  f: (x: unknown) => T,
  max = 200,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(obj(v)).slice(0, max))
    out[str(k, 100)] = f(x);
  return out;
}

function coverage(v: unknown): RunCoverage | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = obj(v);
  const c: RunCoverage = {
    totals: covTotals(o.totals),
    flags: named(o.flags, x => {
      const t: CovTotals & { carried?: true } = covTotals(x);
      if (obj(x).carried === true) t.carried = true;
      return t;
    }),
    components: named(o.components, covTotals),
    carriedForward: arr(o.carriedForward, 200).map(x => str(x, 100)),
    detail: '',
  };
  if (o.patch && typeof o.patch === 'object') {
    const p = obj(o.patch);
    c.patch = {
      ...ratio(p),
      base: sha(p.base),
      partial: p.partial === true,
      files: arr(p.files, 500).map(f => ({
        path: str(obj(f).path, 500),
        ...ratio(f),
      })),
    };
  }
  return c;
}

const STATUSES = Object.keys(STATUS_SEVERITY) as TestStatus[];

function failure(v: unknown): Failure {
  const o = obj(v);
  const f: Failure = {
    id: str(o.id, 1000),
    suite: str(o.suite, 1000),
    name: str(o.name, 1000),
    status: STATUSES.find(s => s === o.status) ?? 'failed',
    uploads: arr(o.uploads, 100).map(x => str(x, 64)),
  };
  const m = str(o.message, 2000);
  if (m) f.message = m;
  return f;
}

function rule(v: unknown): Rule | undefined {
  const o = obj(v);
  const value = Number(o.value);
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  if (
    o.kind === 'total' ||
    o.kind === 'branches' ||
    o.kind === 'patch' ||
    o.kind === 'drop'
  )
    return { kind: o.kind, value };
  if (
    (o.kind === 'component' || o.kind === 'flag') &&
    typeof o.name === 'string'
  )
    return { kind: o.kind, name: str(o.name, 100), value };
  return undefined;
}

/** Only links to GitHub Pages (or the host the caller trusts) survive. */
function safeUrl(v: unknown, trustedHosts: string[]): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return undefined;
    const host = u.hostname.toLowerCase();
    if (host.endsWith('.github.io') || trustedHosts.includes(host))
      return u.toString();
  } catch {}
  return undefined;
}

/** Rebuild an untrusted report from scratch. Throws if it's unusable. */
export function sanitizeReport(
  text: string,
  trustedHosts: string[] = [],
): Report {
  if (text.length > MAX_REPORT_BYTES)
    throw new Error(`report is ${text.length} bytes (max ${MAX_REPORT_BYTES})`);
  const o = obj(JSON.parse(text));
  if (o.kind !== REPORT_KIND) throw new Error('not a standalone-stats report');
  if (o.schema !== SCHEMA)
    throw new Error(`unsupported report schema ${String(o.schema)}`);
  const run = obj(o.run);
  const tests = obj(run.tests);
  const r: Report = {
    kind: REPORT_KIND,
    schema: SCHEMA,
    workflow: str(o.workflow, 100),
    runId: int(o.runId),
    attempt: int(o.attempt) || 1,
    runUrl: '',
    run: {
      key: str(run.key, 64),
      sha: sha(run.sha),
      uploads: arr(run.uploads, 256).map(u => {
        const x = obj(u);
        const s: ReportRun['uploads'][number] = {
          key: str(x.key, 64),
          label: str(x.label, 200),
          tests: totals(x.tests),
        };
        if (x.coverage && typeof x.coverage === 'object')
          s.coverage = covTotals(x.coverage);
        return s;
      }),
      tests: {
        totals: totals(tests.totals),
        unique: int(tests.unique),
        flaky: int(tests.flaky),
        failures: arr(tests.failures, 100).map(failure),
        failuresTruncated: tests.failuresTruncated === true,
        ...(tests.byTest ? { byTest: totals(tests.byTest) } : {}),
      },
    },
    recorded: o.recorded === true,
    rules: arr(o.rules, 100)
      .map(rule)
      .filter((x): x is Rule => !!x),
    wants: {
      comment: obj(o.wants).comment === true,
      statuses: obj(o.wants).statuses === true,
    },
  };
  const cov = coverage(run.coverage);
  if (cov) r.run.coverage = cov;
  const pr = int(o.pr);
  if (pr) r.pr = pr;
  const site = safeUrl(o.siteUrl, trustedHosts);
  if (site) r.siteUrl = site;
  const note = str(o.note, 500);
  if (note) r.note = note;
  if (o.comparison && typeof o.comparison === 'object') {
    const c = obj(o.comparison);
    const ids = (v: unknown) => arr(v, 200).map(x => str(x, 1000));
    const d = obj(c.delta);
    r.comparison = {
      baseKey: str(c.baseKey, 64),
      baseSha: sha(c.baseSha),
      newFailures: ids(c.newFailures),
      fixed: ids(c.fixed),
      stillFailing: ids(c.stillFailing),
      delta: {
        total: signedInt(d.total),
        failed: signedInt(d.failed),
        durationMs: signedInt(d.durationMs),
      },
    };
    const bc = coverage(c.baseCoverage);
    if (bc) r.comparison.baseCoverage = bc;
  }
  return r;
}

// ---------------------------------------------------------------------------
// The comment.

/** Safe for an HTML comment, and stable for matching. */
const markerName = (workflow: string) =>
  workflow
    .replace(/[^\w .-]/g, '')
    .replace(/-{2,}/g, '-')
    .trim() || 'workflow';

export function marker(r: Pick<Report, 'workflow' | 'runId' | 'attempt'>) {
  return `<!-- standalone-stats:${markerName(r.workflow)} run=${r.runId}-${r.attempt} -->`;
}

/** The marker prefix shared by every run of the same workflow. */
export const markerPrefix = (workflow: string) =>
  `<!-- standalone-stats:${markerName(workflow)} run=`;

/** The run id in a comment's marker, if it has one for this workflow. */
export function markerRun(body: string, workflow: string): number | undefined {
  const at = body.indexOf(markerPrefix(workflow));
  if (at < 0) return undefined;
  const m = body
    .slice(at + markerPrefix(workflow).length)
    .match(/^(\d+)-(\d+)/);
  return m ? Number(m[1]) : undefined;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function thresholdLine(results: RuleResult[]): string {
  if (!results.length) return '';
  const icon = (r: RuleResult) => (r.ok === false ? '❌' : r.ok ? '✅' : '➖');
  const sorted = [...results].sort(
    (a, b) => Number(a.ok !== false) - Number(b.ok !== false),
  );
  return `**Thresholds:** ${sorted.map(r => `${icon(r)} ${md(r.label)} ${r.text}`).join(' · ')}`;
}

/** True when there's nothing worth more than a line. */
export function isQuiet(r: Report, results: RuleResult[]): boolean {
  const c = r.comparison;
  if (!c) return false;
  if (failedRules(results).length) return false;
  const t = r.run.tests;
  if (t.failures.length || t.flaky) return false;
  if (c.newFailures.length || c.fixed.length || c.delta.total) return false;
  const cov = r.run.coverage;
  if (cov) {
    if (!c.baseCoverage) return false;
    if (deltaPct(cov.totals.lines, c.baseCoverage.totals.lines) !== '±0')
      return false;
    if (cov.patch && cov.patch.total > 0) return false;
  }
  return true;
}

function testCounts(r: Report): TestTotals {
  return r.run.tests.byTest ?? r.run.tests.totals;
}

/**
 * The PR comment body. `rules` are the thresholds to show (the companion
 * may override the report's own).
 */
export function renderComment(r: Report, rules: Rule[] = r.rules): string {
  const results = evaluate(rules, r.run.coverage, r.comparison?.baseCoverage);
  const t = testCounts(r);
  const bad = t.failed + t.errored;
  const failing = failedRules(results).length > 0;
  const c = r.comparison;
  const short = r.run.sha.slice(0, 7);
  const baseRef = c?.baseSha ? code(c.baseSha.slice(0, 7)) : '';
  const links = [
    r.siteUrl ? `[Dashboard](${r.siteUrl})` : '',
    r.runUrl ? `[Run](${r.runUrl})` : '',
  ].filter(Boolean);
  const head = marker(r);

  if (isQuiet(r, results)) {
    const bits = [
      t.total ? `${t.passed} tests passing` : '',
      r.run.coverage ? `${formatPct(r.run.coverage.totals.lines)} lines` : '',
      ...links,
    ].filter(Boolean);
    const thr = results.length ? `\n\n${thresholdLine(results)}` : '';
    return `${head}\n✅ **Standalone Stats** for ${code(short)}: no test or coverage changes vs ${baseRef}. ${bits.join(' · ')}${thr}\n`;
  }

  const ok = !bad && !failing;
  const out: string[] = [
    head,
    `### ${ok ? '✅' : '❌'} Standalone Stats for ${code(short)}`,
    '',
  ];
  const thr = thresholdLine(results);
  if (thr) out.push(thr, '');

  if (t.total) {
    const jobs = r.run.uploads.length;
    const runs = r.run.tests.totals.total;
    const across =
      runs !== t.total
        ? ` (${runs} results across ${plural(jobs, 'job')})`
        : '';
    const flaky = r.run.tests.flaky ? ` · ⚠️ ${r.run.tests.flaky} flaky` : '';
    if (t.passed === t.total)
      out.push(
        `✅ **${t.passed}** ${t.passed === 1 ? 'test' : 'tests'} passed${across}${flaky}`,
        '',
      );
    else {
      const parts = [
        bad ? `**${bad}** failing` : '',
        `**${t.passed}** passed`,
        t.skipped ? `${t.skipped} skipped` : '',
        t.other ? `${t.other} other` : '',
      ].filter(Boolean);
      out.push(
        `${bad ? '❌' : '✅'} ${parts.join(' · ')} of ${plural(t.total, 'test')}${across}${flaky}`,
        '',
      );
    }
    if (c) {
      const bits = [
        c.newFailures.length
          ? `**${plural(c.newFailures.length, 'new failure')}**`
          : 'no new failures',
        c.fixed.length ? `${c.fixed.length} fixed` : '',
        c.stillFailing.length ? `${c.stillFailing.length} still failing` : '',
      ].filter(Boolean);
      out.push(`Compared with ${baseRef}: ${bits.join(', ')}.`, '');
    }
  }

  const cov = r.run.coverage;
  if (cov) {
    const d = deltaPct(cov.totals.lines, c?.baseCoverage?.totals.lines);
    const bits = [
      `**Coverage ${formatPct(cov.totals.lines)}**${d ? ` (${d})` : ''}`,
      cov.patch
        ? cov.patch.total
          ? `**Patch ${formatPct(cov.patch)}** (${cov.patch.hit}/${cov.patch.total} changed lines ran${cov.patch.partial ? ', diff incomplete' : ''})`
          : 'no coverable lines changed'
        : '',
    ].filter(Boolean);
    out.push(bits.join(' · '), '');
  }

  const details: string[] = [];
  if (c?.newFailures.length) details.push(list('New failures', c.newFailures));
  if (c?.fixed.length) details.push(list('Fixed', c.fixed));
  const failures = r.run.tests.failures;
  if (failures.length) {
    const labels = new Map(r.run.uploads.map(u => [u.key, u.label]));
    const rows = failures.slice(0, 25).map(f => {
      const where = f.uploads.map(k => labels.get(k) ?? k).join(', ');
      const msg = f.message
        ? `\n\n${fence(f.message.split('\n').slice(0, 8).join('\n'), '  ')}`
        : '';
      return `- **${md(f.id)}** (${md(where)})${msg}`;
    });
    details.push(
      `<details><summary>Failures (${failures.length}${r.run.tests.failuresTruncated ? '+' : ''})</summary>\n\n${rows.join('\n')}\n\n</details>\n`,
    );
  }
  if (cov) {
    details.push(missedFiles(cov).join('\n'));
    const hasComponents = Object.keys(cov.components).length > 1;
    const tables = [
      ...(hasComponents
        ? breakdown('Component', cov.components, c?.baseCoverage?.components)
        : []),
      ...breakdown('Flag', cov.flags, c?.baseCoverage?.flags),
    ];
    if (tables.length)
      details.push(
        `<details><summary>Coverage by ${hasComponents && Object.keys(cov.flags).length ? 'component and flag' : hasComponents ? 'component' : 'flag'}</summary>\n\n${tables.join('\n')}\n</details>\n`,
      );
  }
  if (r.run.uploads.length > 1 && t.total) {
    const rows = r.run.uploads.map(u => {
      const f = u.tests.failed + u.tests.errored;
      return `| ${md(u.label)} | ${u.tests.passed} | ${f ? `**${f}**` : 0} | ${u.tests.skipped} | ${formatDuration(u.tests.durationMs)} | ${u.coverage ? formatPct(u.coverage.lines) : ''} |`;
    });
    details.push(
      `<details><summary>${plural(r.run.uploads.length, 'job')}</summary>\n\n| Job | Passed | Failed | Skipped | Time | Lines |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n</details>\n`,
    );
  }
  out.push(...details);
  if (links.length) out.push(links.join(' · '), '');
  if (r.note) out.push(`> ${md(r.note)}`, '');

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (text.length > COMMENT_MAX)
    text = `${text.slice(0, COMMENT_MAX)}\n\n…cut short; the rest is in the dashboard.\n`;
  return text;
}

function list(title: string, ids: string[]): string {
  const shown = ids.slice(0, 25).map(id => `- ${md(id)}`);
  if (ids.length > 25) shown.push(`- …and ${ids.length - 25} more`);
  return `<details><summary>${title} (${ids.length})</summary>\n\n${shown.join('\n')}\n\n</details>\n`;
}
