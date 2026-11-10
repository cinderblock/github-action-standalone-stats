import { fmtDate, fmtDuration } from '../lib/format.js';
import { STATUS_LABEL, type HistoryCode } from '../lib/tests.js';
import { ChartFrame, labelIndexes, niceMax, type Pad } from './frame.js';
import { anchor } from './TestsTrend.js';

const PAD: Pad = { t: 8, r: 8, b: 22, l: 52 };
const H = 160;

export interface DurationPoint {
  key: string;
  time?: string;
  ms: number;
  status: HistoryCode;
}

/** One test's duration per run; bars carry the run's status color. */
export function DurationChart({
  points,
  onOpen,
}: {
  points: DurationPoint[];
  onOpen?: (key: string) => void;
}) {
  const max = niceMax(Math.max(...points.map(p => p.ms), 1));
  const plotH = H - PAD.t - PAD.b;
  const y = (v: number) => (plotH * v) / max;
  const band = (w: number) => (w - PAD.l - PAD.r) / Math.max(1, points.length);
  const cls = (s: HistoryCode) =>
    s === 'p' ? 'pass' : s === 'f' || s === 'e' ? 'fail' : 'skip';

  return (
    <figure className="figure">
      <ChartFrame
        height={H}
        pad={PAD}
        count={points.length}
        label={`Duration over ${points.length} runs`}
        indexAt={(x, w) => Math.floor((x - PAD.l) / band(w))}
        xOf={(i, w) => PAD.l + band(w) * (i + 0.5)}
        {...(onOpen ? { onOpen: (i: number) => onOpen(points[i]!.key) } : {})}
        tooltip={i => {
          const p = points[i]!;
          return (
            <>
              <div className="tip-row">
                <i className={`line-key fill-${cls(p.status)}`} />
                <b>{p.status === '-' ? '—' : fmtDuration(p.ms)}</b>{' '}
                {STATUS_LABEL[p.status]}
              </div>
              {p.time && <div className="tip-time">{fmtDate(p.time)}</div>}
            </>
          );
        }}
      >
        {(w, active) => {
          const bw = band(w);
          const barW = Math.max(1, Math.min(20, bw - 2));
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
                    {fmtDuration(v)}
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
              {points.map((p, i) =>
                p.status === '-' ? null : (
                  <rect
                    key={p.key}
                    className={`fill-${cls(p.status)}`}
                    x={PAD.l + bw * i + (bw - barW) / 2}
                    y={PAD.t + plotH - Math.max(1, y(p.ms))}
                    width={barW}
                    height={Math.max(1, y(p.ms))}
                    rx={Math.min(2, barW / 4)}
                  />
                ),
              )}
              <line
                className="axis"
                x1={PAD.l}
                x2={w - PAD.r}
                y1={PAD.t + plotH}
                y2={PAD.t + plotH}
              />
              {labelIndexes(points.length, w - PAD.l - PAD.r).map(i =>
                points[i]!.time ? (
                  <text
                    key={i}
                    className="tick"
                    x={PAD.l + bw * (i + 0.5)}
                    y={H - 6}
                    textAnchor={anchor(i, points.length)}
                  >
                    {fmtDate(points[i]!.time!)}
                  </text>
                ) : null,
              )}
            </>
          );
        }}
      </ChartFrame>
    </figure>
  );
}
