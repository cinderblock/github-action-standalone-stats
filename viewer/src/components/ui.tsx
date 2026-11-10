import { Component, type ReactNode } from 'react';
import {
  fmtLocal,
  fmtPct,
  fmtUtc,
  level,
  pctOf,
  type Pair,
} from '../lib/format.js';
import type { Ratio } from '../../../src/coverage/model.js';

/** Local time first, UTC beside it in smaller text (visible, not a hover). */
export function Time({ iso, year = true }: { iso: string; year?: boolean }) {
  return (
    <time dateTime={iso} className="time">
      {fmtLocal(iso, year)} <small className="muted">{fmtUtc(iso)}</small>
    </time>
  );
}

export function Tile({
  label,
  value,
  note,
  status,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  status?: 'good' | 'bad' | 'warn';
}) {
  return (
    <div className="tile">
      <div className="tile-label">
        {status && <StatusIcon status={status} />}
        {label}
      </div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

const ICON = { good: '✓', bad: '✕', warn: '!' } as const;
const ICON_LABEL = { good: 'OK', bad: 'Problem', warn: 'Warning' } as const;

export function StatusIcon({ status }: { status: 'good' | 'bad' | 'warn' }) {
  return (
    <span
      className={`status-icon ${status}`}
      role="img"
      aria-label={ICON_LABEL[status]}
    >
      {ICON[status]}
    </span>
  );
}

/** A coverage meter: the percentage as text, a bar beside it. */
export function Meter({
  r,
  digits = 1,
}: {
  r: Ratio | Pair | undefined;
  digits?: number;
}) {
  const p = pctOf(r);
  const lv = level(p);
  return (
    <span className="meter">
      <span className="meter-num">{fmtPct(p, digits)}</span>
      <span className={`meter-bar ${lv}`} aria-hidden="true">
        <span style={{ width: `${p ?? 0}%` }} />
      </span>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading() {
  return <p className="empty">Loading…</p>;
}

export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error?: Error; key?: string }
> {
  state: { error?: Error; key?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error?: Error; key?: string },
  ) {
    if (props.resetKey !== state.key)
      return { error: undefined, key: props.resetKey };
    return null;
  }
  render() {
    if (this.state.error)
      return (
        <div className="error" role="alert">
          <strong>Couldn’t load this.</strong> {this.state.error.message}
        </div>
      );
    return this.props.children;
  }
}

/** Disclosure for detail that's useful but long (failure messages). */
export function Details({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="details">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
