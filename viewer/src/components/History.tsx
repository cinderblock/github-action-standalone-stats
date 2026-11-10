import { STATUS_LABEL, type HistoryCode } from '../lib/tests.js';

/** A test's recent history: one small mark per run, oldest first. The
 *  shapes differ by status (filled, cross, hollow), so it never relies on
 *  color alone. */
export function History({ h, max = 60 }: { h: string; max?: number }) {
  const shown = h.slice(-max);
  const counts = new Map<string, number>();
  for (const c of shown) counts.set(c, (counts.get(c) ?? 0) + 1);
  const label = [...counts]
    .map(([c, n]) => `${n} ${STATUS_LABEL[c as HistoryCode]}`)
    .join(', ');
  return (
    <span
      className="history"
      role="img"
      aria-label={`Last ${shown.length} runs: ${label}`}
    >
      {[...shown].map((c, i) => (
        <span key={i} className={`h h-${c === '-' ? 'none' : c}`} />
      ))}
    </span>
  );
}
