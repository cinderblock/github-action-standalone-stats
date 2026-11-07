/**
 * Flat shields.io-style SVG badges, rendered locally so there's no runtime
 * dependency on a badge service. Widths approximate Verdana 11px, which is
 * what shields.io measures with.
 */

const NARROW = new Set("fijlrt!|.,:;'()[]{} ");
const WIDE = new Set('mwMW%@');

function charWidth(c: string): number {
  if (NARROW.has(c)) return c === ' ' ? 3.9 : 3.6;
  if (WIDE.has(c)) return 10.5;
  if (/[A-Z]/.test(c)) return 7.6;
  if (/[0-9]/.test(c)) return 7;
  if (/[a-z]/.test(c)) return 6.4;
  return 7.5; // symbols, non-ASCII: err wide
}

export function textWidth(s: string): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return Math.ceil(w);
}

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const COLORS = {
  green: '#2e7d32',
  yellowgreen: '#7cb342',
  yellow: '#c79a00',
  orange: '#e65100',
  red: '#c62828',
  grey: '#6e6e6e',
} as const;

export function renderBadge(
  label: string,
  message: string,
  color: string,
): string {
  const lw = textWidth(label) + 10;
  const mw = textWidth(message) + 10;
  const w = lw + mw;
  const l = escape(label);
  const m = escape(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${m}"><title>${l}: ${m}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><text aria-hidden="true" x="${lw * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${l}</text><text x="${lw * 5}" y="140" transform="scale(.1)">${l}</text><text aria-hidden="true" x="${(lw + mw / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${m}</text><text x="${(lw + mw / 2) * 10}" y="140" transform="scale(.1)">${m}</text></g></svg>`;
}

export interface TestBadgeInput {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  total: number;
}

export function testsBadge(t: TestBadgeInput): string {
  const bad = t.failed + t.errored;
  if (t.total === 0) return renderBadge('tests', 'none', COLORS.grey);
  if (bad)
    return renderBadge(
      'tests',
      `${bad} failing, ${t.passed} passing`,
      COLORS.red,
    );
  const msg = t.skipped
    ? `${t.passed} passing, ${t.skipped} skipped`
    : `${t.passed} passing`;
  return renderBadge('tests', msg, COLORS.green);
}
