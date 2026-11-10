import type { IndexEntry } from '../../../src/model.js';
import { fmtDuration, fmtInt, fmtPct, pctOf, shortSha } from '../lib/format.js';
import { href } from '../lib/router.js';
import { failing } from '../lib/runs.js';
import { StatusIcon, Time } from './ui.js';

/** Runs, newest first as given. Each row opens the run page. */
export function RunsTable({ runs }: { runs: IndexEntry[] }) {
  const cov = runs.some(r => r.coverage);
  return (
    <div className="scroll">
      <table className="runs">
        <thead>
          <tr>
            <th>When</th>
            <th>Commit</th>
            <th>Branch</th>
            <th className="n">Passed</th>
            <th className="n">Failing</th>
            <th className="n">Skipped</th>
            {cov && <th className="n">Lines</th>}
            {cov && <th className="n">Patch</th>}
            <th className="n">Time</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => {
            const f = failing(r);
            return (
              <tr key={r.key}>
                <td>
                  <a href={href(['runs', r.key])}>
                    <Time iso={r.time} />
                  </a>
                </td>
                <td>
                  <code>{shortSha(r.sha)}</code>
                </td>
                <td>
                  {r.branch ?? ''}
                  {r.event === 'pull_request' && (
                    <span className="chip">PR</span>
                  )}
                </td>
                <td className="n">{fmtInt(r.tests.passed)}</td>
                <td className="n">
                  {f ? (
                    <>
                      <StatusIcon status="bad" /> {fmtInt(f)}
                    </>
                  ) : (
                    0
                  )}
                </td>
                <td className="n">{fmtInt(r.tests.skipped)}</td>
                {cov && (
                  <td className="n">
                    {r.coverage ? fmtPct(pctOf(r.coverage.l), 2) : ''}
                  </td>
                )}
                {cov && (
                  <td className="n">
                    {r.coverage?.p ? fmtPct(pctOf(r.coverage.p), 1) : ''}
                  </td>
                )}
                <td className="n">{fmtDuration(r.tests.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
