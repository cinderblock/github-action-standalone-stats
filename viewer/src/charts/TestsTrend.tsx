import type { IndexEntry } from '../../../src/model.js';
import { fmtDate, fmtDuration, fmtInt, shortSha } from '../lib/format.js';
import { href, navigate } from '../lib/router.js';
import { failing } from '../lib/runs.js';
import { Time } from '../components/ui.js';
import { ChartFrame, labelIndexes, niceMax, type Pad } from './frame.js';

const PAD: Pad = { t: 8, r: 8, b: 22, l: 40 };
const H = 180;

const anchor = (i: number, n: number) =>
  n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';

/** Results per run, stacked: passed, failing, skipped. Status colors, with
 *  a legend and counts in the tooltip, never color alone. */
export function TestsTrend({ runs }: { runs: IndexEntry[] }) {
  const max = niceMax(Math.max(...runs.map(r => r.tests.total), 1));
  const plotH = H - PAD.t - PAD.b;
  const y = (v: number) => (plotH * v) / max;
  const band = (w: number) => (w - PAD.l - PAD.r) / Math.max(1, runs.length);

  return (
    <figure className="figure">
      <div className="legend">
        <span>
          <i className="key fill-pass" />
          Passed
        </span>
        <span>
          <i className="key fill-fail" />
          Failing
        </span>
        <span>
          <i className="key fill-skip" />
          Skipped
        </span>
      </div>
      <ChartFrame
        height={H}
        pad={PAD}
        count={runs.length}
        label={`Test results for ${runs.length} runs`}
        indexAt={(x, w) => Math.floor((x - PAD.l) / band(w))}
        xOf={(i, w) => PAD.l + band(w) * (i + 0.5)}
        onOpen={i => navigate(href(['runs', runs[i]!.key]))}
        tooltip={i => <Tip r={runs[i]!} />}
      >
        {(w, active) => {
          const bw = band(w);
          const barW = Math.max(1, Math.min(28, bw - 2));
          return (
            <>
              {[0, max / 2, max].map(v => (
                <g key={v}>
                  <line
                    className="grid"
                    x1={PAD.l}
                    x2={w - PAD.r}
                    y1={PAD.t + plotH - y(v)}
                    y2={PAD.t + plotH - y(v)}
                  />
                  <text
                    className="tick"
                    x={PAD.l - 6}
                    y={PAD.t + plotH - y(v) + 4}
                    textAnchor="end"
                  >
                    {fmtInt(v)}
                  </text>
                </g>
              ))}
              {active !== undefined && (
                <rect
                  className="hover-band"
                  x={PAD.l + bw * active}
                  y={PAD.t}
                  width={bw}
                  height={plotH}
                />
              )}
              {runs.map((r, i) => {
                const x = PAD.l + bw * i + (bw - barW) / 2;
                const segs = [
                  ['pass', r.tests.passed],
                  ['fail', failing(r)],
                  ['skip', r.tests.skipped + r.tests.other],
                ] as const;
                let top = PAD.t + plotH;
                let first = true;
                return (
                  <g key={r.key} className="mark">
                    {segs.map(([cls, v]) => {
                      if (!v) return null;
                      const h = y(v);
                      top -= h;
                      // 2px surface gap between stacked segments.
                      const gap = first ? 0 : 2;
                      first = false;
                      return (
                        <rect
                          key={cls}
                          className={`fill-${cls}`}
                          x={x}
                          y={top}
                          width={barW}
                          height={Math.max(1, h - gap)}
                          rx={Math.min(2, barW / 4)}
                        />
                      );
                    })}
                  </g>
                );
              })}
              <line
                className="axis"
                x1={PAD.l}
                x2={w - PAD.r}
                y1={PAD.t + plotH}
                y2={PAD.t + plotH}
              />
              {labelIndexes(runs.length, w - PAD.l - PAD.r).map(i => (
                <text
                  key={i}
                  className="tick"
                  x={PAD.l + bw * (i + 0.5)}
                  y={H - 6}
                  textAnchor={anchor(i, runs.length)}
                >
                  {fmtDate(runs[i]!.time)}
                </text>
              ))}
            </>
          );
        }}
      </ChartFrame>
    </figure>
  );
}

function Tip({ r }: { r: IndexEntry }) {
  const f = failing(r);
  const skipped = r.tests.skipped + r.tests.other;
  return (
    <>
      <div className="tip-head">
        <code>{shortSha(r.sha)}</code>{' '}
        {r.branch && <span className="muted">{r.branch}</span>}
      </div>
      <div className="tip-time">
        <Time iso={r.time} year={false} />
      </div>
      <div className="tip-row">
        <i className="line-key fill-pass" />
        <b>{fmtInt(r.tests.passed)}</b> passed
      </div>
      <div className="tip-row">
        <i className="line-key fill-fail" />
        <b>{fmtInt(f)}</b> failing
      </div>
      {skipped > 0 && (
        <div className="tip-row">
          <i className="line-key fill-skip" />
          <b>{fmtInt(skipped)}</b> skipped
        </div>
      )}
      <div className="tip-row muted">
        {fmtInt(r.unique)} tests · {fmtDuration(r.tests.durationMs)}
      </div>
      <a className="tip-link" href={href(['runs', r.key])}>
        Open run →
      </a>
    </>
  );
}

export { anchor };
