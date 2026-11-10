import type { Ratio } from '../../../src/coverage/model.js';

export type Pair = [number, number];

export const ratioOf = (p: Pair): Ratio => ({ hit: p[0], total: p[1] });

/** Percent, floored to `digits` decimals (never rounds 99.996 up to 100). */
export function pctOf(r: Ratio | Pair | undefined): number | undefined {
  if (!r) return undefined;
  const [hit, total] = Array.isArray(r) ? r : [r.hit, r.total];
  return total ? (100 * hit) / total : undefined;
}

export function fmtPct(p: number | undefined, digits = 1): string {
  if (p === undefined) return 'n/a';
  const f = 10 ** digits;
  return `${(Math.floor(p * f) / f).toFixed(digits)}%`;
}

/** Percentage-point change, signed, or '' when either side is missing. */
export function fmtDelta(a: number | undefined, b: number | undefined): string {
  if (a === undefined || b === undefined) return '';
  const d = Math.round((a - b) * 100) / 100;
  if (d === 0) return '±0';
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtInt = (n: number) => n.toLocaleString('en-US');

/** Local time, 12-hour, with its zone: `Nov 8, 2026, 11:08 PM PST`. */
export function fmtLocal(iso: string, withYear = true): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** UTC, 24-hour: `07:08Z`, with the date when it differs from the local one. */
export function fmtUtc(iso: string): string {
  const d = new Date(iso);
  const hm = d.toISOString().slice(11, 16);
  const localDay = d.toLocaleDateString('en-CA');
  const utcDay = d.toISOString().slice(0, 10);
  if (localDay === utcDay) return `${hm}Z`;
  return `${hm}Z ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export const shortSha = (sha: string) => sha.slice(0, 7);

export function plural(n: number, one: string, many = `${one}s`) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Coverage band for meters and file rows: three levels, kept coarse so
 *  the number, not the color, carries the detail. */
export function level(p: number | undefined): 'good' | 'warn' | 'bad' | 'none' {
  if (p === undefined) return 'none';
  if (p >= 80) return 'good';
  if (p >= 50) return 'warn';
  return 'bad';
}
