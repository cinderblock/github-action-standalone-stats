import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coverageBadge, slug, testsBadge } from '../badge.js';
import {
  SCHEMA,
  STATUS_CODE,
  type DetailFile,
  type IndexCoverage,
  type IndexEntry,
  type Pair,
  type IndexFile,
  type RunRecord,
  type TestsIndex,
} from '../model.js';
import type { MergedTest } from './merge.js';

/**
 * Layout under the stats directory (default `gh-pages:stats/`):
 *
 *   index.html, assets/…        viewer (copied from the action)
 *   badges/tests.svg, coverage.svg, coverage-<component>.svg, flag-<flag>.svg
 *   data/meta.json              schema + generator
 *   data/detail/<runKey>.json   line coverage, newest `detailWindow` runs only
 *   data/index.json             one row per stored run (charts, run list)
 *   data/tests.json             rolling per-test history (flaky/slow)
 *   data/runs/YYYY/MM/<runId>-<attempt>.json
 *
 * Every function here reads only what's already in `root`, so applying the
 * same run to a fresh clone after a lost push race gives the right result.
 */

export function runPath(record: RunRecord): string {
  const t = new Date(record.time);
  const yyyy = String(t.getUTCFullYear());
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  return `data/runs/${yyyy}/${mm}/${record.key}.json`;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function entryOf(record: RunRecord, path: string): IndexEntry {
  const e: IndexEntry = {
    key: record.key,
    time: record.time,
    sha: record.commit.sha,
    event: record.commit.event,
    url: record.run.url,
    tests: record.tests.totals,
    unique: record.tests.unique,
    flaky: record.tests.flaky,
    path,
  };
  if (record.commit.branch) e.branch = record.commit.branch;
  const cov = record.coverage;
  if (cov) {
    const pair = (r: { hit: number; total: number }): Pair => [r.hit, r.total];
    const c: IndexCoverage = {
      l: pair(cov.totals.lines),
      b: pair(cov.totals.branches),
    };
    const comps = Object.entries(cov.components);
    if (comps.length)
      c.c = Object.fromEntries(comps.map(([k, v]) => [k, pair(v.lines)]));
    const flags = Object.entries(cov.flags);
    if (flags.length)
      c.f = Object.fromEntries(flags.map(([k, v]) => [k, pair(v.lines)]));
    if (cov.patch) c.p = pair(cov.patch);
    e.coverage = c;
  }
  return e;
}

async function* walkRuns(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walkRuns(p);
    else if (ent.name.endsWith('.json')) yield p;
  }
}

/** Rebuild `index.json` from the run files, for a missing or unreadable
 *  index (or a schema change). */
export async function rebuildIndex(
  root: string,
  repo: string,
): Promise<IndexFile> {
  const runs: IndexEntry[] = [];
  for await (const p of walkRuns(join(root, 'data', 'runs'))) {
    const r = await readJson<RunRecord>(p);
    if (r?.schema !== SCHEMA) continue;
    runs.push(entryOf(r, runPath(r)));
  }
  runs.sort(
    (a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key),
  );
  return { schema: SCHEMA, repo, updated: new Date().toISOString(), runs };
}

export async function readIndex(
  root: string,
  repo: string,
): Promise<IndexFile> {
  const idx = await readJson<IndexFile>(join(root, 'data', 'index.json'));
  if (idx?.schema === SCHEMA && Array.isArray(idx.runs)) return idx;
  return rebuildIndex(root, repo);
}

/** Fold one run into the rolling per-test history. Re-applying the same run
 *  replaces its column instead of adding one. */
export function updateTestsIndex(
  prev: TestsIndex | undefined,
  key: string,
  tests: Map<string, MergedTest>,
  window: number,
): TestsIndex {
  const idx: TestsIndex =
    prev?.schema === SCHEMA && Array.isArray(prev.runs)
      ? prev
      : { schema: SCHEMA, runs: [], tests: {} };
  let pos = idx.runs.indexOf(key);
  if (pos < 0) {
    idx.runs.push(key);
    pos = idx.runs.length - 1;
    for (const t of Object.values(idx.tests)) {
      t.h += '-';
      t.d.push(-1);
    }
  }
  const n = idx.runs.length;
  for (const m of tests.values()) {
    let e = idx.tests[m.id];
    if (!e) {
      e = {
        suite: m.suite,
        name: m.name,
        h: '-'.repeat(n),
        d: new Array<number>(n).fill(-1),
      };
      if (m.file) e.file = m.file;
      idx.tests[m.id] = e;
    }
    e.h = e.h.slice(0, pos) + STATUS_CODE[m.status] + e.h.slice(pos + 1);
    e.d[pos] = m.durationMs;
  }
  const drop = Math.max(0, idx.runs.length - Math.max(1, window));
  if (drop) {
    idx.runs = idx.runs.slice(drop);
    for (const t of Object.values(idx.tests)) {
      t.h = t.h.slice(drop);
      t.d = t.d.slice(drop);
    }
  }
  for (const [id, t] of Object.entries(idx.tests))
    if (!/[^-]/.test(t.h)) delete idx.tests[id];
  return idx;
}

export interface ApplyOptions {
  repo: string;
  /** Runs kept in `tests.json`. */
  window: number;
  /** Runs (newest first) whose line detail is kept. */
  detailWindow?: number;
  /** This run's line detail, written to `record.coverage.detail`. */
  detail?: DetailFile;
  /** Directory holding the built viewer; skipped if missing. */
  viewerDir?: string;
  generator: { name: string; version: string };
}

/** Write one run into `root` and refresh every derived file. */
export async function applyRun(
  root: string,
  record: RunRecord,
  tests: Map<string, MergedTest>,
  opts: ApplyOptions,
): Promise<IndexFile> {
  const path = runPath(record);
  await writeJson(join(root, path), record);
  if (record.coverage && opts.detail)
    await writeJson(join(root, record.coverage.detail), opts.detail);

  const index = await readIndex(root, opts.repo);
  index.runs = index.runs.filter(r => r.key !== record.key);
  index.runs.push(entryOf(record, path));
  index.runs.sort(
    (a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key),
  );
  index.repo = opts.repo;
  index.updated = new Date().toISOString();
  await writeJson(join(root, 'data', 'index.json'), index);

  const testsPath = join(root, 'data', 'tests.json');
  const prevTests = await readJson<TestsIndex>(testsPath);
  await writeJson(
    testsPath,
    updateTestsIndex(prevTests, record.key, tests, opts.window),
  );

  await writeJson(join(root, 'data', 'meta.json'), {
    schema: SCHEMA,
    generator: opts.generator,
    repo: opts.repo,
    updated: index.updated,
  });

  // Badges describe the newest stored run, not necessarily this one: a slow
  // run that publishes after a newer one mustn't roll the badge back.
  const newest = index.runs[index.runs.length - 1]!;
  await mkdir(join(root, 'badges'), { recursive: true });
  await writeFile(join(root, 'badges', 'tests.svg'), testsBadge(newest.tests));
  const newestCov = [...index.runs].reverse().find(r => r.coverage)?.coverage;
  if (newestCov) await writeCoverageBadges(join(root, 'badges'), newestCov);

  await pruneDetail(root, index, opts.detailWindow ?? 50);

  if (opts.viewerDir && existsSync(opts.viewerDir))
    await cp(opts.viewerDir, root, { recursive: true, force: true });

  return index;
}

async function writeCoverageBadges(dir: string, c: IndexCoverage) {
  // Drop badges for components/flags that no longer exist.
  for (const f of await readdir(dir))
    if (/^(coverage-|flag-).*\.svg$/.test(f)) await rm(join(dir, f));
  await writeFile(join(dir, 'coverage.svg'), coverageBadge('coverage', c.l));
  for (const [name, pair] of Object.entries(c.c ?? {}))
    await writeFile(
      join(dir, `coverage-${slug(name)}.svg`),
      coverageBadge(name, pair),
    );
  for (const [name, pair] of Object.entries(c.f ?? {}))
    await writeFile(join(dir, `flag-${slug(name)}.svg`), coverageBadge(name, pair));
}

/** Keep line detail for the newest `window` runs; it's the bulky part. */
async function pruneDetail(root: string, index: IndexFile, window: number) {
  const dir = join(root, 'data', 'detail');
  if (!existsSync(dir)) return;
  const keep = new Set(
    index.runs.slice(-Math.max(1, window)).map(r => `${r.key}.json`),
  );
  for (const f of await readdir(dir))
    if (f.endsWith('.json') && !keep.has(f)) await rm(join(dir, f));
}

/** Line detail for a stored run, if it's still kept. */
export async function readDetail(
  root: string,
  record: RunRecord,
): Promise<DetailFile | undefined> {
  const rel = record.coverage?.detail;
  if (!rel || !/^data\/detail\/[\w.-]+\.json$/.test(rel)) return undefined;
  const d = await readJson<DetailFile>(join(root, rel));
  return d?.schema === SCHEMA && Array.isArray(d.groups) ? d : undefined;
}

/** The newest stored run on `branch`, ignoring every attempt of
 *  `excludeRunId` (a re-run shouldn't compare against its own first try). */
export async function readBaseline(
  root: string,
  repo: string,
  branch: string,
  excludeRunId?: number,
): Promise<RunRecord | undefined> {
  if (!existsSync(join(root, 'data'))) return undefined;
  const index = await readIndex(root, repo);
  for (let i = index.runs.length - 1; i >= 0; i--) {
    const e = index.runs[i]!;
    if (
      e.branch !== branch ||
      (excludeRunId !== undefined && e.key.startsWith(`${excludeRunId}-`))
    )
      continue;
    const r = await readJson<RunRecord>(join(root, e.path));
    if (r?.schema === SCHEMA) return r;
  }
  return undefined;
}
