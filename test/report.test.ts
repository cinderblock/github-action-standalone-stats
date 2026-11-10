import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { identity } from '../src/collect/gather.js';
import { PermissionError } from '../src/github.js';
import {
  SCHEMA,
  type RunCoverage,
  type TestCase,
  type Upload,
} from '../src/model.js';
import { buildRecord, compare } from '../src/publish/merge.js';
import { fence, md } from '../src/publish/summary.js';
import { postStatuses, upsertComment } from '../src/post.js';
import {
  buildReport,
  isQuiet,
  marker,
  markerRun,
  renderComment,
  sanitizeReport,
  type Report,
} from '../src/report.js';
import {
  evaluate,
  parseThresholds,
  statusesFor,
  type Rule,
} from '../src/thresholds.js';

const tc = (
  name: string,
  status: TestCase['status'],
  message?: string,
): TestCase => ({
  id: `s › ${name}`,
  suite: 's',
  name,
  status,
  durationMs: 10,
  ...(message ? { message } : {}),
});

function upload(label: string, tests: TestCase[]): Upload {
  const id = identity('test', { os: label }, '');
  return {
    schema: SCHEMA,
    key: id.key,
    label: id.label,
    job: 'test',
    dims: id.dims,
    flags: [],
    attempt: 1,
    createdAt: '2026-11-10T00:00:00.000Z',
    sources: [{ format: 'junit', path: 'junit.xml', tests: tests.length }],
    tests,
  };
}

const ratio = (hit: number, total: number) => ({ hit, total });
const covT = (hit: number, total: number) => ({
  files: 3,
  lines: ratio(hit, total),
  branches: ratio(0, 0),
});

function coverage(hit: number, patch?: [number, number]): RunCoverage {
  const c: RunCoverage = {
    totals: covT(hit, 1000),
    flags: { Linux: covT(hit, 1000), Windows: covT(hit - 50, 1000) },
    components: { TypeScript: covT(hit, 900), 'C/C++': covT(50, 100) },
    carriedForward: [],
    detail: 'data/detail/x.json',
  };
  if (patch)
    c.patch = {
      ...ratio(...patch),
      base: 'b'.repeat(40),
      partial: false,
      files: [{ path: 'src/a.ts', ...ratio(...patch) }],
    };
  return c;
}

const ctx = (id: number, sha: string) => ({
  run: {
    id,
    attempt: 1,
    number: id,
    workflow: 'CI',
    url: `https://github.com/o/r/actions/runs/${id}`,
  },
  commit: { sha, ref: 'refs/pull/7/merge', event: 'pull_request', pr: 7 },
  now: new Date('2026-11-10T22:00:00.000Z'),
});

/** A PR run against a base run, with coverage on both. */
function pair(
  cur: { tests: TestCase[][]; cov?: RunCoverage },
  base: { tests: TestCase[][]; cov?: RunCoverage },
) {
  const b = buildRecord(
    base.tests.map((t, i) => upload(`os${i}`, t)),
    ctx(1, 'b'.repeat(40)),
  );
  if (base.cov) b.record.coverage = base.cov;
  const c = buildRecord(
    cur.tests.map((t, i) => upload(`os${i}`, t)),
    ctx(2, 'c'.repeat(40)),
  );
  if (cur.cov) c.record.coverage = cur.cov;
  return {
    record: c.record,
    cmp: compare(c.record, c.tests, b.record),
  };
}

const report = (
  p: ReturnType<typeof pair>,
  rules: Rule[] = [],
  extra: Partial<Parameters<typeof buildReport>[0]> = {},
): Report =>
  buildReport({
    record: p.record,
    cmp: p.cmp,
    workflow: 'CI',
    runUrl: p.record.run.url,
    pr: 7,
    siteUrl: 'https://o.github.io/r/stats/',
    recorded: false,
    rules,
    wants: { comment: true, statuses: rules.length > 0 },
    ...extra,
  });

describe('thresholds', () => {
  it('parses rules, comments and scoped names', () => {
    expect(
      parseThresholds(
        'total: 80\n# a comment\n\npatch: 70% # trailing\ndrop: 0.5\ncomponent C#: 60\nflag Windows: 55\nbranches: 40',
      ),
    ).toEqual([
      { kind: 'total', value: 80 },
      { kind: 'patch', value: 70 },
      { kind: 'drop', value: 0.5 },
      { kind: 'component', name: 'C#', value: 60 },
      { kind: 'flag', name: 'Windows', value: 55 },
      { kind: 'branches', value: 40 },
    ]);
    expect(parseThresholds('')).toEqual([]);
    expect(() => parseThresholds('total 80')).toThrow('line 1');
    expect(() => parseThresholds('lines: 120')).toThrow('over 100');
    expect(() => parseThresholds('statements: 1')).toThrow('unknown rule');
  });

  it('evaluates against coverage and the baseline', () => {
    const rules = parseThresholds(
      'total: 80\npatch: 90\ndrop: 1\ncomponent C/C++: 60\nflag Nope: 10',
    );
    const r = evaluate(rules, coverage(795, [8, 10]), coverage(810));
    expect(r.map(x => [x.label, x.ok])).toEqual([
      ['total', false],
      ['patch', false],
      ['drop', false],
      ['component C/C++', false],
      ['flag Nope', undefined],
    ]);
    expect(r[0]!.text).toBe('79.50% (min 80%)');
    expect(r[2]!.text).toBe('−1.50 pts vs baseline (max drop 1)');
    // A drop of exactly the limit passes; no patch and no baseline skip.
    const ok = evaluate(rules.slice(0, 3), coverage(800), coverage(810));
    expect(ok.map(x => x.ok)).toEqual([true, undefined, true]);
    expect(evaluate(rules.slice(2, 3), coverage(800), undefined)[0]!.text).toBe(
      'no baseline',
    );
  });

  it('groups commit statuses like codecov/project and codecov/patch', () => {
    const rules = parseThresholds('total: 80\ndrop: 5\npatch: 70');
    const s = statusesFor(
      evaluate(rules, coverage(850, [5, 10]), coverage(851)),
    );
    expect(s).toEqual([
      {
        context: 'standalone-stats/coverage',
        state: 'success',
        description:
          'total 85.00% (min 80%); drop −0.10 pts vs baseline (max drop 5)',
      },
      {
        context: 'standalone-stats/patch',
        state: 'failure',
        description: '50.00% (min 70%)',
      },
    ]);
    // Only failing rules are described when something fails; no patch
    // rule means no patch status.
    const f = statusesFor(
      evaluate(
        parseThresholds('total: 90\ndrop: 5'),
        coverage(850),
        coverage(851),
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.description).toBe('total 85.00% (min 90%)');
    const long = statusesFor(
      evaluate(
        Array.from({ length: 20 }, (_, i) => ({
          kind: 'flag' as const,
          name: `flag-${i}`,
          value: 1,
        })),
        coverage(850),
        undefined,
      ),
    );
    expect(long[0]!.description).toBe('Nothing to measure');
  });
});

describe('markdown safety', () => {
  it('defuses mentions and issue references', () => {
    expect(md('@cinderblock fixes #12 and o/r#3')).toBe(
      '@&#8203;cinderblock fixes #&#8203;12 and o/r#&#8203;3',
    );
    expect(md('a@b.c')).toBe('a@&#8203;b.c');
  });
  it('fences text that contains fences', () => {
    expect(fence('x\n```\ny')).toBe('````\nx\n```\ny\n````');
    expect(fence('plain', '  ')).toBe('  ```\n  plain\n  ```');
  });
});

describe('comment', () => {
  const green = [
    [tc('a', 'passed'), tc('b', 'passed')],
    [tc('a', 'passed'), tc('b', 'passed')],
  ];

  it('is one line when nothing changed', () => {
    const p = pair(
      { tests: green, cov: coverage(850) },
      { tests: green, cov: coverage(850) },
    );
    const r = report(p);
    expect(isQuiet(r, [])).toBe(true);
    const body = renderComment(r);
    expect(body.split('\n').filter(Boolean)).toHaveLength(2);
    expect(body).toStartWith(marker(r));
    expect(body).toContain('no test or coverage changes vs `bbbbbbb`');
    expect(body).toContain('2 tests passing');
  });

  it('shows failures, patch and thresholds when something changed', () => {
    const p = pair(
      {
        tests: [
          [tc('a', 'passed'), tc('b', 'failed', 'expected 1\n```\n@someone')],
          [tc('a', 'passed'), tc('b', 'passed')],
        ],
        cov: coverage(840, [3, 4]),
      },
      { tests: green, cov: coverage(850) },
    );
    const r = report(p, parseThresholds('total: 80\npatch: 90'));
    const body = renderComment(r);
    expect(body).toContain('### ❌ Standalone Stats for `ccccccc`');
    expect(body).toContain(
      '**Thresholds:** ❌ patch 75.00% (min 90%) · ✅ total 84.00% (min 80%)',
    );
    expect(body).toContain('**1** failing');
    expect(body).toContain('2 tests (4 results across 2 jobs)');
    expect(body).toContain('**1 new failure**');
    expect(body).toContain('**Coverage 84.00%** (−1.00 pts)');
    expect(body).toContain('**Patch 75.00%** (3/4 changed lines ran)');
    expect(body).toContain('Changed files with uncovered lines (1)');
    expect(body).toContain('Coverage by component and flag');
    // The message can't close its fence (and code doesn't ping anyone).
    expect(body).toContain('  ````\n  expected 1\n  ```\n  @someone\n  ````');
    expect(body).toContain('| Linux | 84.00% (840/1000) | −1.00 pts |');
    expect(body).toContain('[Dashboard](https://o.github.io/r/stats/)');
  });

  it('reads the run id back from its marker', () => {
    const p = pair({ tests: green }, { tests: green });
    const body = renderComment(report(p));
    expect(markerRun(body, 'CI')).toBe(2);
    expect(markerRun(body, 'Other')).toBeUndefined();
    expect(marker({ workflow: 'a --> b', runId: 1, attempt: 2 })).toBe(
      '<!-- standalone-stats:a - b run=1-2 -->',
    );
  });
});

describe('sanitizeReport', () => {
  const p = pair(
    { tests: [[tc('a', 'failed', 'boom')]], cov: coverage(840, [3, 4]) },
    { tests: [[tc('a', 'passed')]], cov: coverage(850) },
  );
  const good = report(p, parseThresholds('total: 80'));

  it('round-trips a real report', () => {
    const back = sanitizeReport(JSON.stringify(good));
    expect(renderComment(back)).toBe(renderComment({ ...good, runUrl: '' }));
    expect(back.wants).toEqual({ comment: true, statuses: true });
  });

  it('rebuilds hostile input: types, sizes, links', () => {
    const evil = JSON.parse(JSON.stringify(good));
    evil.run.tests.byTest.passed = '[click](https://evil.example)';
    evil.run.uploads[0].label = 'x'.repeat(5000);
    evil.siteUrl = 'https://evil.example/';
    evil.runUrl = 'javascript:alert(1)';
    evil.rules.push({ kind: 'exec', value: 1 }, { kind: 'total', value: 1e9 });
    evil.comparison.newFailures = Array(10_000).fill('x');
    evil.pr = '7; drop';
    const r = sanitizeReport(JSON.stringify(evil));
    expect(r.run.tests.byTest!.passed).toBe(0);
    expect(r.run.uploads[0]!.label).toHaveLength(200);
    expect(r.siteUrl).toBeUndefined();
    expect(r.runUrl).toBe('');
    expect(r.rules).toEqual([{ kind: 'total', value: 80 }]);
    expect(r.comparison!.newFailures).toHaveLength(200);
    expect(r.pr).toBeUndefined();
    expect(
      sanitizeReport(
        JSON.stringify({ ...good, siteUrl: 'https://stats.example.com/x' }),
        ['stats.example.com'],
      ).siteUrl,
    ).toBe('https://stats.example.com/x');
    expect(() => sanitizeReport('{"kind":"other"}')).toThrow(
      'not a standalone-stats report',
    );
    expect(() => sanitizeReport('x'.repeat(5_000_001))).toThrow('max');
  });
});

describe('posting', () => {
  // A fake GitHub API: comments on PR 7, statuses, and a forbidden PR 8.
  type C = {
    id: number;
    body: string;
    user: { login: string; type: string };
    html_url: string;
  };
  let comments: C[] = [];
  const statuses: { sha: string; body: Record<string, string> }[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let api: { token: string; apiUrl: string };
  const repo = { owner: 'o', name: 'r' };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url);
        const json = (b: unknown, status = 200) => Response.json(b, { status });
        if (
          u.pathname === '/repos/o/r/issues/7/comments' &&
          req.method === 'GET'
        )
          return json(comments);
        if (
          u.pathname === '/repos/o/r/issues/7/comments' &&
          req.method === 'POST'
        ) {
          const c = {
            id: 100 + comments.length,
            body: ((await req.json()) as { body: string }).body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            html_url: `https://github.com/o/r/pull/7#c${100 + comments.length}`,
          };
          comments.push(c);
          return json(c, 201);
        }
        const m = u.pathname.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/);
        if (m && req.method === 'PATCH') {
          const c = comments.find(x => x.id === Number(m[1]))!;
          c.body = ((await req.json()) as { body: string }).body;
          return json(c);
        }
        if (u.pathname === '/repos/o/r/issues/8/comments')
          return json(
            { message: 'Resource not accessible by integration' },
            403,
          );
        const s = u.pathname.match(/^\/repos\/o\/r\/statuses\/(\w+)$/);
        if (s) {
          statuses.push({
            sha: s[1]!,
            body: (await req.json()) as Record<string, string>,
          });
          return json({}, 201);
        }
        return json({ message: 'Not Found' }, 404);
      },
    });
    api = { token: 't', apiUrl: `http://127.0.0.1:${server.port}` };
  });
  afterAll(() => server.stop(true));

  const p = pair(
    { tests: [[tc('a', 'passed')]] },
    { tests: [[tc('a', 'failed')]] },
  );
  const r = report(p);

  it('creates, then edits the same comment', async () => {
    comments = [
      {
        id: 1,
        body: `${marker({ workflow: 'CI', runId: 1, attempt: 1 })}\nspoof`,
        user: { login: 'someone', type: 'User' },
        html_url: '',
      },
    ];
    const a = await upsertComment(repo, 7, r, [], api);
    expect(a.action).toBe('created');
    const b = await upsertComment(repo, 7, { ...r, attempt: 2 }, [], api);
    expect(b).toEqual({ action: 'updated', url: (a as { url: string }).url });
    expect(comments).toHaveLength(2);
    expect(comments[0]!.body).toContain('spoof');
    expect(comments[1]!.body).toContain('run=2-2');
  });

  it("doesn't overwrite a newer run's comment", async () => {
    const res = await upsertComment(repo, 7, { ...r, runId: 1 }, [], api);
    expect(res).toEqual({
      action: 'skipped',
      reason: 'the comment is from a newer run (2)',
    });
  });

  it('reports a read-only token as a PermissionError', async () => {
    const err = await upsertComment(repo, 8, r, [], api).catch(e => e);
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as Error).message).toContain('Resource not accessible');
  });

  it('posts one status per group', async () => {
    const rules = parseThresholds('total: 80\npatch: 50');
    const n = await postStatuses(
      repo,
      'c'.repeat(40),
      evaluate(rules, coverage(850, [1, 4]), undefined),
      'https://o.github.io/r/stats/',
      api,
    );
    expect(n).toBe(2);
    expect(statuses.map(s => [s.body.context, s.body.state])).toEqual([
      ['standalone-stats/coverage', 'success'],
      ['standalone-stats/patch', 'failure'],
    ]);
    expect(statuses[0]!.body.target_url).toBe('https://o.github.io/r/stats/');
  });
});
