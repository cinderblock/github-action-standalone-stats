/**
 * Coverage model.
 *
 * In memory, coverage is `path → line → { hits, br }`:
 *  - `hits`: execution count for the line (summed when merging sessions).
 *  - `br`: one char per branch on the line, `1` taken, `0` not. lcov `BRDA`
 *    records give real branch identities, in the order listed. Cobertura only
 *    has counts (`condition-coverage="50% (1/2)"`), which we encode
 *    front-filled (`10`). OR-merging two strings then gives the union for
 *    lcov and Codecov's "max covered of max total" for Cobertura.
 *
 * On disk (uploads and detail files) each file is `{ p, l, b? }`: `l` is
 * `[lineDelta, hits, lineDelta, hits, …]` sorted by line, and `b` maps a line
 * number to its branch string.
 */

export type CoverageFormat = 'lcov' | 'cobertura';
export const COVERAGE_FORMAT_LIST: readonly CoverageFormat[] = [
  'lcov',
  'cobertura',
];

export interface LineCov {
  /** Execution count, or -1 for a line that only carries branch data (lcov
   *  `BRDA` on a line with no `DA`): it isn't a coverable line itself. */
  hits: number;
  br?: string;
}

export type FileCov = Map<number, LineCov>;
export type Coverage = Map<string, FileCov>;

/** Serialized coverage for one file. */
export interface CoverageFileData {
  p: string;
  l: number[];
  b?: Record<string, string>;
}

export interface Ratio {
  hit: number;
  total: number;
}

export interface CovTotals {
  files: number;
  lines: Ratio;
  branches: Ratio;
}

/** Hard limits for hostile input (fork PR artifacts are untrusted). */
export const LIMITS = {
  files: 100_000,
  linesPerFile: 1_000_000,
  lines: 20_000_000,
  branchesPerLine: 1024,
};

/** OR two branch strings, padding the shorter with `0`. */
export function orBranches(a: string | undefined, b: string | undefined) {
  if (!a) return b;
  if (!b) return a;
  const n = Math.max(a.length, b.length);
  let out = '';
  for (let i = 0; i < n; i++) out += a[i] === '1' || b[i] === '1' ? '1' : '0';
  return out;
}

/** Fold `line` into `file`: hits add up, branches OR together. */
export function addLine(file: FileCov, line: number, cov: LineCov): void {
  const cur = file.get(line);
  if (!cur) {
    file.set(line, cov.br ? { hits: cov.hits, br: cov.br } : { hits: cov.hits });
    return;
  }
  cur.hits =
    cur.hits < 0 && cov.hits < 0
      ? -1
      : Math.max(0, cur.hits) + Math.max(0, cov.hits);
  const br = orBranches(cur.br, cov.br);
  if (br) cur.br = br;
}

/** Merge `src` into `target` (mutates `target`). */
export function mergeCoverage(target: Coverage, src: Coverage): Coverage {
  for (const [path, lines] of src) {
    let file = target.get(path);
    if (!file) {
      file = new Map();
      target.set(path, file);
    }
    for (const [line, cov] of lines) addLine(file, line, cov);
  }
  return target;
}

export function emptyCovTotals(): CovTotals {
  return {
    files: 0,
    lines: { hit: 0, total: 0 },
    branches: { hit: 0, total: 0 },
  };
}

export function fileTotals(file: FileCov): CovTotals {
  const t = emptyCovTotals();
  t.files = 1;
  for (const cov of file.values()) {
    if (cov.hits >= 0) t.lines.total++;
    if (cov.hits > 0) t.lines.hit++;
    if (cov.br) {
      t.branches.total += cov.br.length;
      for (const c of cov.br) if (c === '1') t.branches.hit++;
    }
  }
  return t;
}

export function addTotals(a: CovTotals, b: CovTotals): CovTotals {
  return {
    files: a.files + b.files,
    lines: { hit: a.lines.hit + b.lines.hit, total: a.lines.total + b.lines.total },
    branches: {
      hit: a.branches.hit + b.branches.hit,
      total: a.branches.total + b.branches.total,
    },
  };
}

/** Totals over every file in `cov`, or only those `include` accepts. */
export function totals(
  cov: Coverage,
  include?: (path: string) => boolean,
): CovTotals {
  let t = emptyCovTotals();
  for (const [path, file] of cov)
    if (!include || include(path)) t = addTotals(t, fileTotals(file));
  return t;
}

/** Percentage with two decimals, or undefined when nothing is coverable. */
export function pct(r: Ratio): number | undefined {
  if (!r.total) return undefined;
  return Math.floor((10000 * r.hit) / r.total) / 100;
}

export function formatPct(r: Ratio): string {
  const p = pct(r);
  return p === undefined ? 'n/a' : `${p.toFixed(2)}%`;
}

export function encodeFile(path: string, file: FileCov): CoverageFileData {
  const lines = [...file.keys()].sort((a, b) => a - b);
  const l: number[] = [];
  const b: Record<string, string> = {};
  let prev = 0;
  for (const n of lines) {
    const cov = file.get(n)!;
    l.push(n - prev, cov.hits);
    prev = n;
    if (cov.br) b[String(n)] = cov.br;
  }
  const out: CoverageFileData = { p: path, l };
  if (Object.keys(b).length) out.b = b;
  return out;
}

export function encodeCoverage(cov: Coverage): CoverageFileData[] {
  return [...cov.keys()].sort().map(p => encodeFile(p, cov.get(p)!));
}

/**
 * Decode serialized coverage, validating as we go: data from artifacts is
 * untrusted, so malformed entries are dropped and the limits enforced.
 */
export function decodeCoverage(raw: unknown): Coverage {
  const cov: Coverage = new Map();
  if (!Array.isArray(raw)) return cov;
  if (raw.length > LIMITS.files)
    throw new Error(`coverage has ${raw.length} files (max ${LIMITS.files})`);
  let budget = LIMITS.lines;
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const { p, l, b } = f as Record<string, unknown>;
    if (typeof p !== 'string' || !p || p.length > 1000 || !Array.isArray(l))
      continue;
    if (l.length / 2 > Math.min(LIMITS.linesPerFile, budget))
      throw new Error(`coverage for ${p.slice(0, 200)} exceeds the line limit`);
    budget -= l.length / 2;
    const file: FileCov = cov.get(p) ?? new Map();
    let line = 0;
    for (let i = 0; i + 1 < l.length; i += 2) {
      const d = Number(l[i]);
      const hits = Number(l[i + 1]);
      if (!Number.isInteger(d) || d < 0) break;
      line += d;
      if (line < 1) continue;
      addLine(file, line, {
        hits: hits === -1 ? -1 : Number.isFinite(hits) && hits > 0 ? hits : 0,
      });
    }
    if (b && typeof b === 'object')
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
        const n = Number(k);
        const cur = file.get(n);
        if (
          !cur ||
          typeof v !== 'string' ||
          v.length > LIMITS.branchesPerLine ||
          !/^[01]+$/.test(v)
        )
          continue;
        cur.br = orBranches(cur.br, v)!;
      }
    if (file.size) cov.set(p, file);
  }
  return cov;
}
