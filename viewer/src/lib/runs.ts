import type { IndexEntry, IndexFile } from '../../../src/model.js';

/** The branch most push runs were on: what the overview shows by default. */
export function mainBranch(runs: IndexEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const r of runs)
    if (r.event !== 'pull_request' && r.branch)
      counts.set(r.branch, (counts.get(r.branch) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [b, c] of counts) if (c > n) [best, n] = [b, c];
  return best ?? runs.find(r => r.branch)?.branch;
}

export function branches(runs: IndexEntry[]): string[] {
  const seen = new Map<string, string>();
  for (const r of runs) if (r.branch) seen.set(r.branch, r.time);
  return [...seen.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([b]) => b);
}

/** `''` means every branch. PR runs count under their head branch. */
export function onBranch(runs: IndexEntry[], branch: string): IndexEntry[] {
  return branch ? runs.filter(r => r.branch === branch) : runs;
}

/** Repo web URL, from a run URL (works on GitHub Enterprise hosts too). */
export function repoUrl(index: IndexFile): string {
  const url = index.runs.at(-1)?.url;
  const m = url && /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/actions\/runs\//.exec(url);
  return m ? m[1]! : `https://github.com/${index.repo}`;
}

export const failing = (r: { tests: { failed: number; errored: number } }) =>
  r.tests.failed + r.tests.errored;

/** The run before `key` on the same branch, for deltas. */
export function previousOnBranch(
  runs: IndexEntry[],
  key: string,
): IndexEntry | undefined {
  const i = runs.findIndex(r => r.key === key);
  if (i < 0) return undefined;
  const branch = runs[i]!.branch;
  for (let j = i - 1; j >= 0; j--)
    if (runs[j]!.branch === branch && runs[j]!.event !== 'pull_request')
      return runs[j];
  return undefined;
}

/** Every flag or component name across `runs`, in a stable order, so a
 *  series keeps its color when filters change. */
export function seriesNames(runs: IndexEntry[], kind: 'c' | 'f'): string[] {
  const names = new Set<string>();
  for (const r of runs)
    for (const n of Object.keys(r.coverage?.[kind] ?? {})) names.add(n);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The `branch` query value: absent means the main branch, `all` means
 *  every branch (returned as `''`). */
export function branchParam(
  query: URLSearchParams,
  main: string | undefined,
): string {
  const q = query.get('branch');
  if (q === 'all') return '';
  return q ?? main ?? '';
}
