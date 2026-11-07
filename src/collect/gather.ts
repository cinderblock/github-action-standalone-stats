import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import * as glob from '@actions/glob';
import { SCHEMA, type TestFormat, type Upload } from '../model.js';
import { toPosix } from '../paths.js';
import { readTestPaths, TEST_FORMATS } from '../readers/index.js';

export interface Identity {
  key: string;
  label: string;
  job: string;
  dims: Record<string, string>;
}

/** Parse the `matrix` input (`${{ toJSON(matrix) }}`): "null", "" or an
 *  object. Values are flattened to strings; nested objects stay JSON. */
export function parseMatrix(raw: string): Record<string, string> {
  const s = raw.trim();
  if (!s || s === 'null') return {};
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new Error(`matrix input isn't JSON: ${s.slice(0, 200)}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>))
    out[k] = typeof val === 'string' ? val : JSON.stringify(val);
  return out;
}

/**
 * A stable identity for one producing step: job id + matrix values + an
 * optional user id. Stable across re-runs, so a re-run's upload replaces the
 * failed attempt's instead of adding to it.
 */
export function identity(
  job: string,
  matrix: Record<string, string>,
  id: string,
  runnerOs?: string,
): Identity {
  const keys = Object.keys(matrix).sort();
  const canonical = JSON.stringify([job, keys.map(k => [k, matrix[k]]), id]);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const values = keys.map(k => matrix[k]);
  const parts = [...values, ...(id ? [id] : [])];
  const label = parts.length ? `${job} (${parts.join(', ')})` : job;
  const dims = { ...matrix };
  if (runnerOs) dims['runner.os'] = runnerOs;
  return { key, label, job, dims };
}

export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function parseFormat(raw: string): TestFormat | undefined {
  const v = raw.trim().toLowerCase();
  if (!v || v === 'auto') return undefined;
  if ((TEST_FORMATS as string[]).includes(v)) return v as TestFormat;
  throw new Error(
    `Unknown test format ${JSON.stringify(raw)} (expected auto, ${TEST_FORMATS.join(', ')})`,
  );
}

export async function expand(patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  const g = await glob.create(patterns.join('\n'), {
    matchDirectories: true,
    implicitDescendants: false,
    followSymbolicLinks: false,
  });
  return [...new Set(await g.glob())].sort();
}

export interface GatherOptions {
  identity: Identity;
  testPatterns: string[];
  testFormat?: TestFormat;
  flags: string[];
  workspace: string;
  attempt: number;
  now?: Date;
}

export async function gather(o: GatherOptions): Promise<Upload> {
  const paths = await expand(o.testPatterns);
  const results = await readTestPaths(paths, o.workspace, o.testFormat);
  return {
    schema: SCHEMA,
    key: o.identity.key,
    label: o.identity.label,
    job: o.identity.job,
    dims: o.identity.dims,
    flags: [...new Set(o.flags)].sort(),
    attempt: o.attempt,
    createdAt: (o.now ?? new Date()).toISOString(),
    sources: results.map(r => ({
      format: r.format,
      path: toPosix(relative(o.workspace, r.path)) || '.',
      tests: r.tests.length,
    })),
    tests: results.flatMap(r => r.tests),
  };
}
