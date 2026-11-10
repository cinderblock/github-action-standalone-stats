import { use } from 'react';
import type { CovTotals } from '../../../src/coverage/model.js';
import type { IndexEntry, RunCoverage, RunRecord } from '../../../src/model.js';
import {
  Details,
  Empty,
  Meter,
  StatusIcon,
  Tile,
  Time,
} from '../components/ui.js';
import { getIndex, getRun } from '../lib/data.js';
import {
  fmtDelta,
  fmtDuration,
  fmtInt,
  fmtPct,
  pctOf,
  plural,
  shortSha,
} from '../lib/format.js';
import { href } from '../lib/router.js';
import { mainBranch, previousOnBranch, repoUrl } from '../lib/runs.js';

/** The run this one is compared with: the previous run on its branch, or
 *  for a PR, the newest main-branch run before it. */
function baselineOf(runs: IndexEntry[], entry: IndexEntry) {
  if (entry.event !== 'pull_request') return previousOnBranch(runs, entry.key);
  const main = mainBranch(runs);
  return runs
    .filter(
      r =>
        r.branch === main && r.event !== 'pull_request' && r.time <= entry.time,
    )
    .at(-1);
}

export function Run({ runKey }: { runKey: string }) {
  const index = use(getIndex());
  const entry = index.runs.find(r => r.key === runKey);
  if (!entry) return <Empty>Run {runKey} isn’t stored.</Empty>;
  const rec = use(getRun(entry.path));
  const base = baselineOf(index.runs, entry);
  const repo = repoUrl(index);
  const t = rec.tests.totals;
  const bad = t.failed + t.errored;
  const c = rec.coverage;
  const vs = (a: { hit: number; total: number }, b?: [number, number]) => {
    const d = fmtDelta(pctOf(a), pctOf(b));
    return d && base
      ? `${d} pts vs ${shortSha(base.sha)}`
      : `${fmtInt(a.hit)} of ${fmtInt(a.total)}`;
  };

  return (
    <>
      <h1 className="page-title">
        {rec.run.workflow} #{rec.run.number}
        {rec.run.attempt > 1 && (
          <span className="muted"> (attempt {rec.run.attempt})</span>
        )}
      </h1>
      <p className="lede">
        <a href={`${repo}/commit/${rec.commit.sha}`}>
          <code>{shortSha(rec.commit.sha)}</code>
        </a>{' '}
        on <b>{rec.commit.branch ?? rec.commit.ref}</b>
        {rec.commit.pr && (
          <>
            {' '}
            · <a href={`${repo}/pull/${rec.commit.pr}`}>PR #{rec.commit.pr}</a>
          </>
        )}{' '}
        · {rec.commit.event} · <Time iso={rec.time} /> ·{' '}
        <a href={rec.run.url}>workflow run</a>
      </p>
      <div className="tiles">
        <Tile
          label="Failing"
          value={fmtInt(bad)}
          status={bad ? 'bad' : 'good'}
          note={`${fmtInt(t.passed)} passed`}
        />
        <Tile
          label="Tests"
          value={fmtInt(rec.tests.unique)}
          note={`${plural(t.total, 'result')}, ${plural(rec.uploads.length, 'job')}`}
        />
        <Tile label="Skipped" value={fmtInt(t.skipped + t.other)} />
        <Tile
          label="Flaky"
          value={fmtInt(rec.tests.flaky)}
          {...(rec.tests.flaky ? { status: 'warn' as const } : {})}
        />
        <Tile
          label="Test time"
          value={fmtDuration(t.durationMs)}
          note="summed over jobs"
        />
        {c && (
          <Tile
            label="Lines"
            value={fmtPct(pctOf(c.totals.lines), 2)}
            note={vs(c.totals.lines, base?.coverage?.l)}
          />
        )}
        {c && c.totals.branches.total > 0 && (
          <Tile
            label="Branches"
            value={fmtPct(pctOf(c.totals.branches), 2)}
            note={vs(c.totals.branches, base?.coverage?.b)}
          />
        )}
        {c?.patch && (
          <Tile
            label="Patch"
            value={c.patch.total ? fmtPct(pctOf(c.patch), 2) : 'n/a'}
            note={
              c.patch.total
                ? `${fmtInt(c.patch.hit)} of ${fmtInt(c.patch.total)} changed lines ran`
                : 'no coverable lines changed'
            }
          />
        )}
      </div>

      <section>
        <h2>Jobs</h2>
        <Jobs rec={rec} />
      </section>

      <section>
        <h2>Failures</h2>
        <Failures rec={rec} />
      </section>

      {c && <CoverageDetail rec={rec} c={c} base={base} />}
    </>
  );
}

function Jobs({ rec }: { rec: RunRecord }) {
  const cov = rec.uploads.some(u => u.coverage);
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Flags</th>
            <th className="n">Passed</th>
            <th className="n">Failing</th>
            <th className="n">Skipped</th>
            <th className="n">Time</th>
            {cov && <th className="n">Lines</th>}
          </tr>
        </thead>
        <tbody>
          {rec.uploads.map(u => {
            const f = u.tests.failed + u.tests.errored;
            return (
              <tr key={u.key}>
                <td>
                  {u.label}
                  {u.formats.length > 0 && (
                    <div className="muted small">{u.formats.join(', ')}</div>
                  )}
                </td>
                <td>
                  {u.flags.map(f => (
                    <span className="chip" key={f}>
                      {f}
                    </span>
                  ))}
                </td>
                <td className="n">{fmtInt(u.tests.passed)}</td>
                <td className="n">
                  {f ? (
                    <>
                      <StatusIcon status="bad" /> {fmtInt(f)}
                    </>
                  ) : (
                    0
                  )}
                </td>
                <td className="n">{fmtInt(u.tests.skipped)}</td>
                <td className="n">{fmtDuration(u.tests.durationMs)}</td>
                {cov && (
                  <td className="n">
                    {u.coverage ? (
                      <Meter r={u.coverage.lines} digits={2} />
                    ) : (
                      ''
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Failures({ rec }: { rec: RunRecord }) {
  const labels = new Map(rec.uploads.map(u => [u.key, u.label]));
  const f = rec.tests.failures;
  if (!f.length) return <Empty>No failures.</Empty>;
  return (
    <>
      <ul className="list failures">
        {f.map(x => (
          <li key={x.id}>
            <StatusIcon status="bad" />{' '}
            <a href={href(['test'], { id: x.id })}>{x.name}</a>{' '}
            <span className="muted small">{x.status}</span>
            <div className="muted small">
              {x.suite}
              {x.file && <> · {x.file}</>} ·{' '}
              {x.uploads.map(k => labels.get(k) ?? k).join(', ')}
            </div>
            {x.message && (
              <Details summary="Message">
                <pre className="message">{x.message}</pre>
              </Details>
            )}
          </li>
        ))}
      </ul>
      {rec.tests.failuresTruncated && (
        <p className="muted">
          More failures than the stored limit; the rest are in the workflow
          logs.
        </p>
      )}
    </>
  );
}

function Breakdown({
  title,
  cur,
  base,
  link,
}: {
  title: string;
  cur: Record<string, CovTotals & { carried?: true }>;
  base: Record<string, [number, number]> | undefined;
  link?: (name: string) => string;
}) {
  const names = Object.keys(cur).sort((a, b) => a.localeCompare(b));
  if (!names.length) return null;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            <th className="n">Lines</th>
            {base && <th className="n">Change (pts)</th>}
            <th className="n">Branches</th>
            <th className="n">Files</th>
          </tr>
        </thead>
        <tbody>
          {names.map(n => {
            const v = cur[n]!;
            const b = base?.[n];
            return (
              <tr key={n}>
                <td>
                  {link ? <a href={link(n)}>{n}</a> : n}
                  {v.carried && <span className="chip">carried forward</span>}
                </td>
                <td className="n">
                  <Meter r={v.lines} digits={2} />
                </td>
                {base && (
                  <td className="n">
                    {b ? fmtDelta(pctOf(v.lines), pctOf(b)) || '' : 'new'}
                  </td>
                )}
                <td className="n">
                  {v.branches.total ? fmtPct(pctOf(v.branches), 2) : 'n/a'}
                </td>
                <td className="n">{fmtInt(v.files)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoverageDetail({
  rec,
  c,
  base,
}: {
  rec: RunRecord;
  c: RunCoverage;
  base: IndexEntry | undefined;
}) {
  const kept = !!c.detail;
  const fileLink = (path: string) => href(['coverage', rec.key, 'file', path]);
  return (
    <section>
      <h2>
        Coverage{' '}
        {kept && (
          <a className="h-link" href={href(['coverage', rec.key])}>
            Browse files →
          </a>
        )}
      </h2>
      {c.carriedForward.length > 0 && (
        <p className="note">
          Carried forward from an earlier run (these flags didn’t run this
          time):{' '}
          {c.carriedForward.map(f => (
            <span className="chip" key={f}>
              {f}
            </span>
          ))}
        </p>
      )}
      <Breakdown
        title="Component"
        cur={c.components}
        base={base?.coverage?.c}
      />
      <Breakdown
        title="Flag"
        cur={c.flags}
        base={base?.coverage?.f}
        link={f => href(['coverage', rec.key], { flags: f })}
      />
      {c.patch && c.patch.files.length > 0 && (
        <>
          <h3>Changed files</h3>
          <p className="muted small">
            Coverable lines changed since <code>{shortSha(c.patch.base)}</code>
            {c.patch.partial && ' (the diff was too large to read in full)'}.
            Worst first.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th className="n">Patch</th>
                  <th className="n">Missed</th>
                </tr>
              </thead>
              <tbody>
                {c.patch.files.map(f => (
                  <tr key={f.path}>
                    <td className="path">
                      {kept ? <a href={fileLink(f.path)}>{f.path}</a> : f.path}
                    </td>
                    <td className="n">
                      <Meter r={f} />
                    </td>
                    <td className="n">{fmtInt(f.total - f.hit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
