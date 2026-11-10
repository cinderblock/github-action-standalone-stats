import { Suspense, use, useMemo, useState } from 'react';
import type { IndexEntry } from '../../../src/model.js';
import { CoverageTrend, type Series } from '../charts/CoverageTrend.js';
import { TestsTrend } from '../charts/TestsTrend.js';
import { History } from '../components/History.js';
import { RunsTable } from '../components/RunsTable.js';
import { BranchPicker } from '../components/BranchPicker.js';
import {
  Empty,
  ErrorBoundary,
  Loading,
  Meter,
  Tile,
  Time,
} from '../components/ui.js';
import { getIndex, getRun, getTests } from '../lib/data.js';
import {
  fmtDelta,
  fmtDuration,
  fmtInt,
  fmtPct,
  pctOf,
  plural,
  shortSha,
} from '../lib/format.js';
import { href, navigate, useRoute } from '../lib/router.js';
import {
  failing,
  branchParam,
  mainBranch,
  onBranch,
  repoUrl,
  seriesNames,
} from '../lib/runs.js';
import { sortTests, testRows } from '../lib/tests.js';

const TREND_RUNS = 100;

export function Overview() {
  const index = use(getIndex());
  const route = useRoute();
  const main = mainBranch(index.runs);
  const branch = branchParam(route.query, main);
  const runs = onBranch(index.runs, branch);
  const last = runs.at(-1);

  if (!index.runs.length) return <Empty>No runs stored yet.</Empty>;

  return (
    <>
      <div className="filters">
        <BranchPicker
          runs={index.runs}
          value={branch}
          onChange={b =>
            navigate(
              href([], { branch: b === main ? undefined : b || 'all' }),
              true,
            )
          }
        />
      </div>
      {!last ? (
        <Empty>No runs on this branch.</Empty>
      ) : (
        <>
          <Latest last={last} prev={runs.at(-2)} repo={repoUrl(index)} />
          <section>
            <h2>Tests</h2>
            <TestsTrend runs={runs.slice(-TREND_RUNS)} />
          </section>
          {runs.some(r => r.coverage) && (
            <CoverageSection runs={runs.slice(-TREND_RUNS)} />
          )}
          <div className="two-col">
            <section>
              <h2>Latest failures</h2>
              <ErrorBoundary resetKey={last.key}>
                <Suspense fallback={<Loading />}>
                  <Failures entry={last} />
                </Suspense>
              </ErrorBoundary>
            </section>
            <section>
              <h2>Flakiest tests</h2>
              <ErrorBoundary>
                <Suspense fallback={<Loading />}>
                  <Flaky />
                </Suspense>
              </ErrorBoundary>
            </section>
          </div>
          <section>
            <h2>
              Recent runs{' '}
              <a
                className="h-link"
                href={href(['runs'], {
                  branch: route.query.get('branch') ?? undefined,
                })}
              >
                All runs →
              </a>
            </h2>
            <RunsTable runs={runs.slice(-10).reverse()} />
          </section>
        </>
      )}
    </>
  );
}

function Latest({
  last,
  prev,
  repo,
}: {
  last: IndexEntry;
  prev: IndexEntry | undefined;
  repo: string;
}) {
  const t = last.tests;
  const bad = failing(last);
  const c = last.coverage;
  const delta = (a?: [number, number], b?: [number, number]) => {
    const d = fmtDelta(pctOf(a), pctOf(b));
    return d ? `${d} pts vs previous` : undefined;
  };
  return (
    <section>
      <p className="lede">
        Latest:{' '}
        <a href={`${repo}/commit/${last.sha}`}>
          <code>{shortSha(last.sha)}</code>
        </a>{' '}
        on <b>{last.branch ?? '?'}</b>, <Time iso={last.time} /> ·{' '}
        <a href={href(['runs', last.key])}>details</a> ·{' '}
        <a href={last.url}>workflow run</a>
      </p>
      <div className="tiles">
        <Tile
          label="Failing"
          value={fmtInt(bad)}
          status={bad ? 'bad' : 'good'}
          note={`${fmtInt(t.passed)} passed${t.skipped ? `, ${fmtInt(t.skipped)} skipped` : ''}`}
        />
        <Tile
          label="Tests"
          value={fmtInt(last.unique)}
          note={`${plural(t.total, 'result')} across jobs`}
        />
        <Tile
          label="Flaky"
          value={fmtInt(last.flaky)}
          {...(last.flaky ? { status: 'warn' as const } : {})}
          note="passed on retry"
        />
        <Tile
          label="Test time"
          value={fmtDuration(t.durationMs)}
          note="summed over jobs"
        />
        {c && (
          <>
            <Tile
              label="Lines"
              value={fmtPct(pctOf(c.l), 2)}
              note={
                delta(c.l, prev?.coverage?.l) ??
                `${fmtInt(c.l[0])} of ${fmtInt(c.l[1])}`
              }
            />
            {c.b[1] > 0 && (
              <Tile
                label="Branches"
                value={fmtPct(pctOf(c.b), 2)}
                note={
                  delta(c.b, prev?.coverage?.b) ??
                  `${fmtInt(c.b[0])} of ${fmtInt(c.b[1])}`
                }
              />
            )}
            {c.p && (
              <Tile
                label="Patch"
                value={fmtPct(pctOf(c.p), 2)}
                note={`${fmtInt(c.p[0])} of ${fmtInt(c.p[1])} changed lines ran`}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

type Breakdown = 'total' | 'f' | 'c';

function CoverageSection({ runs }: { runs: IndexEntry[] }) {
  const route = useRoute();
  const flags = useMemo(() => seriesNames(runs, 'f'), [runs]);
  const comps = useMemo(() => seriesNames(runs, 'c'), [runs]);
  const [by, setBy] = useState<Breakdown>('total');
  const covRuns = runs.filter(r => r.coverage);
  const last = covRuns.at(-1)!;

  const series: Series[] =
    by === 'total'
      ? [
          { name: 'Lines', slot: 1, values: covRuns.map(r => r.coverage!.l) },
          ...(covRuns.some(r => r.coverage!.b[1])
            ? [
                {
                  name: 'Branches',
                  slot: 2,
                  values: covRuns.map(r =>
                    r.coverage!.b[1] ? r.coverage!.b : undefined,
                  ),
                },
              ]
            : []),
        ]
      : (by === 'f' ? flags : comps).map((name, k) => ({
          name,
          slot: (k % 8) + 1,
          values: covRuns.map(r => r.coverage![by]?.[name]),
        }));

  const rows = [
    ...comps.map(n => ['Component', n, last.coverage!.c?.[n]] as const),
    ...flags.map(n => ['Flag', n, last.coverage!.f?.[n]] as const),
  ].filter(r => r[2]);

  return (
    <section>
      <h2>
        Coverage{' '}
        <a
          className="h-link"
          href={href(['coverage', last.key], {
            branch: route.query.get('branch') ?? undefined,
          })}
        >
          Browse files →
        </a>
      </h2>
      <div
        className="segmented"
        role="radiogroup"
        aria-label="Coverage breakdown"
      >
        {(
          [
            ['total', 'Total'],
            ...(flags.length > 1 ? [['f', 'By flag']] : []),
            ...(comps.length > 1 ? [['c', 'By component']] : []),
          ] as [Breakdown, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            role="radio"
            aria-checked={by === k}
            className={by === k ? 'on' : ''}
            onClick={() => setBy(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <CoverageTrend runs={covRuns} series={series} />
      {rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th className="n">Lines</th>
                <th className="n">Covered</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([kind, name, v]) => (
                <tr key={kind + name}>
                  <td className="muted">{kind}</td>
                  <td>
                    {kind === 'Flag' ? (
                      <a href={href(['coverage', last.key], { flags: name })}>
                        {name}
                      </a>
                    ) : (
                      name
                    )}
                  </td>
                  <td className="n">
                    <Meter r={v} digits={2} />
                  </td>
                  <td className="n">
                    {fmtInt(v![0])} / {fmtInt(v![1])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Failures({ entry }: { entry: IndexEntry }) {
  const rec = use(getRun(entry.path));
  const labels = new Map(rec.uploads.map(u => [u.key, u.label]));
  const f = rec.tests.failures;
  if (!f.length) return <Empty>None in the latest run.</Empty>;
  return (
    <ul className="list">
      {f.slice(0, 8).map(x => (
        <li key={x.id}>
          <a href={href(['test'], { id: x.id })}>{x.name}</a>
          <div className="muted small">
            {x.suite} · {x.uploads.map(k => labels.get(k) ?? k).join(', ')}
          </div>
        </li>
      ))}
      {f.length > 8 && (
        <li>
          <a href={href(['runs', entry.key])}>…and {f.length - 8} more</a>
        </li>
      )}
    </ul>
  );
}

function Flaky() {
  const tests = use(getTests());
  const rows = sortTests(testRows(tests), 'flaky')
    .filter(r => r.flips >= 2)
    .slice(0, 8);
  if (!rows.length)
    return (
      <Empty>
        No test flipped between passing and failing in the last{' '}
        {tests.runs.length} runs.
      </Empty>
    );
  return (
    <ul className="list">
      {rows.map(r => (
        <li key={r.id}>
          <a href={href(['test'], { id: r.id })}>{r.name}</a>
          <div className="muted small">
            {r.suite} · {plural(r.flips, 'flip')}
          </div>
          <History h={r.h} max={40} />
        </li>
      ))}
      <li>
        <a href={href(['tests'], { sort: 'flaky' })}>All tests →</a>
      </li>
    </ul>
  );
}
