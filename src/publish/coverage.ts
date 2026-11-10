import { assignComponents, type Component } from '../coverage/components.js';
import {
  decodeCoverage,
  encodeCoverage,
  mergeCoverage,
  totals,
  type Coverage,
  type CovTotals,
} from '../coverage/model.js';
import { patchCoverage, type Diff } from '../coverage/patch.js';
import {
  SCHEMA,
  type DetailFile,
  type RunCoverage,
  type Upload,
} from '../model.js';

/** Patch files kept in a run record. */
export const PATCH_FILE_CAP = 100;

export interface CoverageOptions {
  key: string;
  sha: string;
  components: Component[];
  /** Whether a flag's coverage is carried forward when it's missing. */
  carryforward: (flag: string) => boolean;
  baselineDetail?: DetailFile;
  diff?: { diff: Diff; base: string };
}

export interface CoverageBuild {
  coverage: RunCoverage;
  merged: Coverage;
  detail: DetailFile;
  perUpload: Map<string, CovTotals>;
}

export function detailPath(key: string): string {
  return `data/detail/${key}.json`;
}

interface Group {
  flags: string[];
  cov: Coverage;
}

const groupKey = (flags: string[]) => JSON.stringify([...flags].sort());

function addGroup(groups: Map<string, Group>, flags: string[], cov: Coverage) {
  const k = groupKey(flags);
  const g = groups.get(k);
  if (g) mergeCoverage(g.cov, cov);
  else
    groups.set(k, {
      flags: [...flags].sort(),
      cov: mergeCoverage(new Map(), cov),
    });
}

/**
 * Merge every upload's coverage the way Codecov merges sessions: coverable
 * lines are the union, hits add up, branches OR together. Sessions are
 * grouped by flag set; a baseline group whose flags are all missing from
 * this run (and all carryforward-enabled) is carried in.
 */
export function buildCoverage(
  uploads: Upload[],
  o: CoverageOptions,
): CoverageBuild | undefined {
  const groups = new Map<string, Group>();
  const perUpload = new Map<string, CovTotals>();
  const present = new Set<string>();
  for (const u of uploads) {
    if (!u.coverage) continue;
    const cov = decodeCoverage(u.coverage.files);
    perUpload.set(u.key, totals(cov));
    for (const f of u.flags) present.add(f);
    addGroup(groups, u.flags, cov);
  }

  const carried = new Set<string>();
  for (const g of o.baselineDetail?.groups ?? []) {
    const flags = Array.isArray(g.flags) ? g.flags.map(String) : [];
    if (!flags.length) continue;
    if (!flags.every(f => !present.has(f) && o.carryforward(f))) continue;
    for (const f of flags) carried.add(f);
    addGroup(groups, flags, decodeCoverage(g.files));
  }
  if (!groups.size) return undefined;

  const merged: Coverage = new Map();
  for (const g of groups.values()) mergeCoverage(merged, g.cov);

  const allFlags = [
    ...new Set([...groups.values()].flatMap(g => g.flags)),
  ].sort();
  const flags: RunCoverage['flags'] = {};
  for (const f of allFlags) {
    const cov: Coverage = new Map();
    for (const g of groups.values())
      if (g.flags.includes(f)) mergeCoverage(cov, g.cov);
    flags[f] = carried.has(f) ? { ...totals(cov), carried: true } : totals(cov);
  }

  const assignment = assignComponents(merged.keys(), o.components);
  const names = [...new Set([...assignment.values()].flat())].sort();
  const components: RunCoverage['components'] = {};
  for (const name of names)
    components[name] = totals(
      merged,
      p => assignment.get(p)?.includes(name) ?? false,
    );

  const detail = detailPath(o.key);
  const coverage: RunCoverage = {
    totals: totals(merged),
    flags,
    components,
    carriedForward: [...carried].sort(),
    detail,
  };
  if (o.diff) {
    const p = patchCoverage(merged, o.diff.diff, o.diff.base);
    coverage.patch = { ...p, files: p.files.slice(0, PATCH_FILE_CAP) };
  }

  return {
    coverage,
    merged,
    perUpload,
    detail: {
      schema: SCHEMA,
      key: o.key,
      sha: o.sha,
      groups: [...groups.values()]
        .sort((a, b) => groupKey(a.flags).localeCompare(groupKey(b.flags)))
        .map(g => ({ flags: g.flags, files: encodeCoverage(g.cov) })),
    },
  };
}

/** Parse the `carryforward` input: `true`/`all`, `false`, or flag names. */
export function parseCarryforward(raw: string): (flag: string) => boolean {
  const v = raw.trim();
  if (!v || /^(false|no|off|0|none)$/i.test(v)) return () => false;
  if (/^(true|yes|on|1|all)$/i.test(v)) return () => true;
  const set = new Set(
    v
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(Boolean),
  );
  return f => set.has(f);
}
