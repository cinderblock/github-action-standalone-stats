/**
 * Coverage in the browser: the same decode and merge the publisher uses
 * (`src/coverage/model.ts`), plus a directory tree for browsing.
 */
import {
  addTotals,
  decodeCoverage,
  emptyCovTotals,
  fileTotals,
  mergeCoverage,
  type Coverage,
  type CovTotals,
  type FileCov,
} from '../../../src/coverage/model.js';
import type { DetailFile } from '../../../src/model.js';

export type { Coverage, CovTotals, FileCov };

/** Every flag in a detail file, sorted. */
export function detailFlags(detail: DetailFile): string[] {
  return [...new Set(detail.groups.flatMap(g => g.flags))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Merge the detail's groups. With `flags`, only groups carrying at least one
 * of them are included (an upload with no flags belongs to no flag, so it's
 * only in the unfiltered view, like Codecov).
 */
export function mergeDetail(detail: DetailFile, flags?: string[]): Coverage {
  const want = flags?.length ? new Set(flags) : undefined;
  const out: Coverage = new Map();
  for (const g of detail.groups) {
    if (want && !g.flags.some(f => want.has(f))) continue;
    mergeCoverage(out, decodeCoverage(g.files));
  }
  return out;
}

export interface TreeEntry {
  name: string;
  /** Full repo-relative path. */
  path: string;
  dir: boolean;
  totals: CovTotals;
  /** Files below (1 for a file). */
  files: number;
}

/**
 * The children of directory `dir` (`''` for the root). Chains of single
 * directories are collapsed (`src/coverage` instead of `src` → `coverage`),
 * so deep layouts don't take a click per level.
 */
export function listDir(
  cov: Coverage,
  totalsByFile: Map<string, CovTotals>,
  dir: string,
): TreeEntry[] {
  const prefix = dir ? `${dir}/` : '';
  const children = new Map<string, TreeEntry>();
  for (const path of cov.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const isDir = slash >= 0;
    const key = `${isDir ? 'd' : 'f'}:${name}`;
    const t = totalsByFile.get(path)!;
    const e = children.get(key);
    if (e) {
      e.totals = addTotals(e.totals, t);
      e.files++;
    } else
      children.set(key, {
        name,
        path: prefix + name,
        dir: isDir,
        totals: addTotals(emptyCovTotals(), t),
        files: 1,
      });
  }
  const out = [...children.values()].map(e =>
    e.dir ? collapse(cov, e) : e,
  );
  return out.sort(
    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
  );
}

function collapse(cov: Coverage, e: TreeEntry): TreeEntry {
  let cur = e;
  for (;;) {
    const kids = listDirShallow(cov, cur.path);
    if (kids.length !== 1 || !kids[0]!.dir) return cur;
    const only = kids[0]!;
    cur = { ...cur, name: `${cur.name}/${only.name}`, path: only.path };
  }
}

/** Names of the immediate children of `dir`, without totals. */
function listDirShallow(
  cov: Coverage,
  dir: string,
): { name: string; path: string; dir: boolean }[] {
  const prefix = `${dir}/`;
  const seen = new Map<string, { name: string; path: string; dir: boolean }>();
  for (const path of cov.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    seen.set(`${slash >= 0}:${name}`, {
      name,
      path: prefix + name,
      dir: slash >= 0,
    });
  }
  return [...seen.values()];
}

export function totalsByFile(cov: Coverage): Map<string, CovTotals> {
  return new Map([...cov].map(([p, f]) => [p, fileTotals(f)]));
}

export type LineState = 'hit' | 'miss' | 'partial' | 'none';

export interface LineView {
  n: number;
  state: LineState;
  /** Execution count; undefined for a line that isn't coverable. */
  hits?: number;
  /** Branches taken / total, when the line has branches. */
  br?: [number, number];
}

/** One row per line, 1…max(source length, last coverable line). */
export function lineViews(file: FileCov, sourceLines = 0): LineView[] {
  let max = sourceLines;
  for (const n of file.keys()) max = Math.max(max, n);
  const out: LineView[] = [];
  for (let n = 1; n <= max; n++) {
    const c = file.get(n);
    if (!c) {
      out.push({ n, state: 'none' });
      continue;
    }
    const v: LineView = { n, state: 'none' };
    if (c.hits >= 0) v.hits = c.hits;
    let taken = 0;
    if (c.br) {
      for (const b of c.br) if (b === '1') taken++;
      v.br = [taken, c.br.length];
    }
    const branchMiss = !!c.br && taken < c.br.length;
    if (c.hits === 0) v.state = 'miss';
    else if (branchMiss) v.state = 'partial';
    else if (c.hits > 0 || (c.br && taken)) v.state = 'hit';
    else if (c.br) v.state = 'miss';
    out.push(v);
  }
  return out;
}

/** Contiguous runs of missed (or partial) lines, for "jump to next". */
export function missRanges(
  lines: LineView[],
  include: LineState[] = ['miss'],
): [number, number][] {
  const out: [number, number][] = [];
  for (const l of lines) {
    if (!include.includes(l.state)) continue;
    const last = out.at(-1);
    // Lines that aren't coverable don't break a range.
    if (last && lines.slice(last[1], l.n - 1).every(x => x.state === 'none'))
      last[1] = l.n;
    else out.push([l.n, l.n]);
  }
  return out;
}
