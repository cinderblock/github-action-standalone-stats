import type { Coverage, Ratio } from './model.js';

/** Changed (added or modified) lines per file, from a diff. */
export interface Diff {
  /** Head-side line numbers added in each file. */
  files: Map<string, Set<number>>;
  /** True when the diff is incomplete (the API's file cap). */
  partial: boolean;
  /** Changed files the API sent no patch for (binary, or too large, like a
   *  committed bundle). They only make the result incomplete if they have
   *  coverage. */
  omitted?: string[];
}

/** Added line numbers (head side) of a unified diff hunk list. */
export function addedLines(patch: string): Set<number> {
  const out = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const l = raw.replace(/\r$/, '');
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (l.startsWith('+')) out.add(line++);
    else if (l.startsWith('-')) continue;
    else if (l.startsWith('\\'))
      continue; // "\ No newline at end of file"
    else line++;
  }
  return out;
}

export interface PatchFile extends Ratio {
  path: string;
}

export interface PatchCoverage extends Ratio {
  /** Base commit the diff was taken against. */
  base: string;
  partial: boolean;
  /** Changed files that have coverable changed lines, worst first. */
  files: PatchFile[];
}

/** Of the changed lines that are coverable, how many ran. */
export function patchCoverage(
  cov: Coverage,
  diff: Diff,
  base: string,
): PatchCoverage {
  const files: PatchFile[] = [];
  let hit = 0;
  let total = 0;
  for (const [path, lines] of diff.files) {
    const file = cov.get(path);
    if (!file) continue;
    let fh = 0;
    let ft = 0;
    for (const n of lines) {
      const c = file.get(n);
      if (!c || c.hits < 0) continue;
      ft++;
      if (c.hits > 0) fh++;
    }
    if (!ft) continue;
    files.push({ path, hit: fh, total: ft });
    hit += fh;
    total += ft;
  }
  files.sort(
    (a, b) => a.hit / a.total - b.hit / b.total || a.path.localeCompare(b.path),
  );
  const partial =
    diff.partial || (diff.omitted ?? []).some(path => cov.has(path));
  return { base, partial, hit, total, files };
}
