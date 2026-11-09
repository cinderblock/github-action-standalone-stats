import { LIMITS, addLine, orBranches, type FileCov } from './model.js';

/** A coverage report before its paths are resolved. */
export interface RawCoverage {
  /** Raw file name as written in the report → lines. */
  files: Map<string, FileCov>;
  /** Directories the report says its relative names are under. */
  bases: string[];
}

export function isLcov(text: string): boolean {
  return /^(?:TN|SF):/m.test(text.slice(0, 64 * 1024));
}

/**
 * Parse an lcov tracefile (`SF`, `DA`, `BRDA`, `end_of_record`). The same
 * file appearing in several records (one per test name, say) is merged.
 * `FN*` and the summary lines (`LF`, `LH`, `BRF`, `BRH`) are ignored: totals
 * are recomputed from the line data so every format counts the same way.
 */
export function readLcov(text: string): RawCoverage {
  const files = new Map<string, FileCov>();
  let file: FileCov | undefined;
  /** BRDA for the current record: line → [block, branch, taken][] */
  let branches = new Map<number, [string, string, boolean][]>();
  let lines = 0;

  const flush = () => {
    if (!file) return;
    for (const [line, list] of branches) {
      const br = list
        .slice(0, LIMITS.branchesPerLine)
        .map(([, , taken]) => (taken ? '1' : '0'))
        .join('');
      // Istanbul puts BRDA on a branch's start line, which may have no DA.
      // Such a line carries branches but isn't a coverable line itself.
      const cur = file.get(line);
      if (cur) cur.br = orBranches(cur.br, br)!;
      else file.set(line, { hits: -1, br });
    }
    branches = new Map();
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flush();
      const name = line.slice(3).trim();
      file = files.get(name);
      if (!file) {
        if (files.size >= LIMITS.files)
          throw new Error(`more than ${LIMITS.files} files in an lcov report`);
        file = new Map();
        files.set(name, file);
      }
    } else if (line === 'end_of_record') {
      flush();
      file = undefined;
    } else if (!file) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',');
      const ln = Number(n);
      if (!Number.isInteger(ln) || ln < 1) continue;
      if (++lines > LIMITS.lines)
        throw new Error(`more than ${LIMITS.lines} lines in an lcov report`);
      const h = Number(hits);
      addLine(file, ln, { hits: Number.isFinite(h) && h > 0 ? h : 0 });
    } else if (line.startsWith('BRDA:')) {
      const [n, block, branch, taken] = line.slice(5).split(',');
      const ln = Number(n);
      if (!Number.isInteger(ln) || ln < 1 || block === undefined) continue;
      const list = branches.get(ln) ?? [];
      list.push([block, branch ?? '', taken !== '-' && Number(taken) > 0]);
      branches.set(ln, list);
    }
  }
  flush();
  return { files, bases: [] };
}
