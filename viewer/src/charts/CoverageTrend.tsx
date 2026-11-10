import type { IndexEntry } from '../../../src/model.js';
import { fmtDate, fmtPct, pctOf, shortSha, type Pair } from '../lib/format.js';
import { href, navigate } from '../lib/router.js';
import { Time } from '../components/ui.js';
import { ChartFrame, labelIndexes, type Pad } from './frame.js';
import { anchor } from './TestsTrend.js';

export interface Series {
  name: string;
  /** Categorical slot (1–8), fixed per entity so filters never repaint it. */
  slot: number;
  /** Per run, `[hit, total]`, or undefined when the run has no value. */
  values: (Pair | undefined)[];
}

const PAD: Pad = { t: 12, r: 12, b: 22, l: 44 };
const H = 220;

/** Coverage % per run, one line per series, one shared axis. */
export function CoverageTrend({
  runs,
  series,
}: {
  runs: IndexEntry[];
  series: Series[];
}) {
  const all = series
    .flatMap(s => s.values.map(v => pctOf(v)))
    .filter((v): v is number => v !== undefined);
  let lo = all.length ? Math.floor(Math.min(...all) / 10) * 10 : 0;
  const hi = all.length
    ? Math.min(100, Math.ceil(Math.max(...all) / 10) * 10)
    : 100;
  if (hi - lo < 10) lo = Math.max(0, hi - 10);
  const plotH = H - PAD.t - PAD.b;
  const y = (p: number) =>
    PAD.t + plotH - (plotH * (p - lo)) / Math.max(1, hi - lo);
  const step = (w: number) =>
    (w - PAD.l - PAD.r) / Math.max(1, runs.length - 1);
  const x = (i: number, w: number) =>
    runs.length === 1 ? (PAD.l + w - PAD.r) / 2 : PAD.l + step(w) * i;
  const ticks = [lo, (lo + hi) / 2, hi];
  const direct = series.length > 1 && series.length <= 4;

  return (
    <figure className="figure">
      {series.length > 1 && (
        <div className="legend">
          {series.map(s => (
            <span key={s.name}>
              <i className={`line-key s${s.slot}`} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <ChartFrame
        height={H}
        pad={PAD}
        count={runs.length}
        label={`Coverage for ${runs.length} runs`}
        indexAt={(px, w) =>
          runs.length === 1 ? 0 : Math.round((px - PAD.l) / step(w))
        }
        xOf={x}
        onOpen={i => navigate(href(['runs', runs[i]!.key]))}
        tooltip={i => <Tip r={runs[i]!} series={series} i={i} />}
      >
        {(w, active) => (
          <>
            {ticks.map(v => (
              <g key={v}>
                <line
                  className="grid"
                  x1={PAD.l}
                  x2={w - PAD.r}
                  y1={y(v)}
                  y2={y(v)}
                />
                <text
                  className="tick"
                  x={PAD.l - 6}
                  y={y(v) + 4}
                  textAnchor="end"
                >
                  {v}%
                </text>
              </g>
            ))}
            {active !== undefined && (
              <line
                className="crosshair"
                x1={x(active, w)}
                x2={x(active, w)}
                y1={PAD.t}
                y2={PAD.t + plotH}
              />
            )}
            {series.map(s => {
              // Break the line where a run has no value.
              const segs: string[][] = [[]];
              s.values.forEach((v, i) => {
                const p = pctOf(v);
                if (p === undefined) segs.push([]);
                else
                  segs.at(-1)!.push(`${x(i, w).toFixed(1)},${y(p).toFixed(1)}`);
              });
              const has = (i: number) => pctOf(s.values[i]) !== undefined;
              return (
                <g key={s.name} className={`series s${s.slot}`}>
                  {segs
                    .filter(p => p.length > 1)
                    .map((p, k) => (
                      <polyline key={k} points={p.join(' ')} />
                    ))}
                  {s.values.map((v, i) => {
                    const p = pctOf(v);
                    if (p === undefined) return null;
                    // Markers only where needed: the active run, and runs
                    // that would otherwise be an invisible lone point.
                    const lone = !has(i - 1) && !has(i + 1);
                    if (!lone && i !== active) return null;
                    return <circle key={i} cx={x(i, w)} cy={y(p)} r={4} />;
                  })}
                </g>
              );
            })}
            {direct &&
              series.map(s => {
                const last = s.values.findLastIndex(
                  v => pctOf(v) !== undefined,
                );
                if (last < 0) return null;
                return (
                  <text
                    key={s.name}
                    className="direct-label"
                    x={x(last, w) - 4}
                    y={y(pctOf(s.values[last])!) - 7}
                    textAnchor="end"
                  >
                    {s.name}
                  </text>
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
                x={x(i, w)}
                y={H - 6}
                textAnchor={anchor(i, runs.length)}
              >
                {fmtDate(runs[i]!.time)}
              </text>
            ))}
          </>
        )}
      </ChartFrame>
    </figure>
  );
}

function Tip({ r, series, i }: { r: IndexEntry; series: Series[]; i: number }) {
  return (
    <>
      <div className="tip-head">
        <code>{shortSha(r.sha)}</code>{' '}
        {r.branch && <span className="muted">{r.branch}</span>}
      </div>
      <div className="tip-time">
        <Time iso={r.time} year={false} />
      </div>
      {series.map(s => {
        const v = s.values[i];
        return (
          <div className="tip-row" key={s.name}>
            <i className={`line-key s${s.slot}`} />
            <b>{fmtPct(pctOf(v), 2)}</b> {s.name}
            {v && (
              <span className="muted">
                {' '}
                {v[0]}/{v[1]}
              </span>
            )}
          </div>
        );
      })}
      <a className="tip-link" href={href(['runs', r.key])}>
        Open run →
      </a>
    </>
  );
}
