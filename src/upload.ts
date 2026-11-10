import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA,
  STATUS_SEVERITY,
  TEST_FORMAT_LIST,
  truncate,
  type TestCase,
  type TestStatus,
  type Upload,
} from './model.js';
import {
  COVERAGE_FORMAT_LIST,
  decodeCoverage,
  encodeCoverage,
} from './coverage/model.js';

export const DEFAULT_PREFIX = 'standalone-stats-';
/** Same as `report.ts`; not imported, to keep collect's bundle small. */
const REPORT_ARTIFACT = 'standalone-stats-report';
const FILE = 'upload.json';

/** Limits on what we accept from an upload. Artifacts from fork PRs are
 *  attacker-controlled, so everything is validated and capped. */
const MAX_TESTS = 200_000;
const MAX_STR = 1000;

const str = (v: unknown, max = MAX_STR): string =>
  typeof v === 'string' ? v.slice(0, max) : '';
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Validate and normalize an upload document. Throws if it's unusable. */
export function validateUpload(raw: unknown): Upload {
  if (!raw || typeof raw !== 'object')
    throw new Error('upload is not an object');
  const u = raw as Record<string, unknown>;
  if (u.schema !== SCHEMA)
    throw new Error(
      `unsupported upload schema ${String(u.schema)} (expected ${SCHEMA})`,
    );
  const key = str(u.key, 64);
  if (!/^[0-9a-f]{8,64}$/.test(key))
    throw new Error('upload key is missing or malformed');
  const tests = Array.isArray(u.tests) ? u.tests : [];
  if (tests.length > MAX_TESTS)
    throw new Error(`upload has ${tests.length} tests (max ${MAX_TESTS})`);
  const dims: Record<string, string> = {};
  if (u.dims && typeof u.dims === 'object')
    for (const [k, v] of Object.entries(
      u.dims as Record<string, unknown>,
    ).slice(0, 50))
      dims[k.slice(0, 100)] = str(v, 200);

  const out: Upload = {
    schema: SCHEMA,
    key,
    label: str(u.label, 300) || key,
    job: str(u.job, 200),
    dims,
    flags: (Array.isArray(u.flags) ? u.flags : [])
      .map(f => str(f, 100))
      .filter(Boolean)
      .slice(0, 50),
    attempt: Math.max(1, Math.floor(num(u.attempt))),
    createdAt: str(u.createdAt, 40),
    sources: (Array.isArray(u.sources) ? u.sources : [])
      .slice(0, 1000)
      .map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        const format = TEST_FORMAT_LIST.find(f => f === o.format) ?? 'junit';
        return { format, path: str(o.path), tests: Math.floor(num(o.tests)) };
      }),
    tests: tests.map(validateTest),
  };
  const cov = u.coverage as Record<string, unknown> | undefined;
  if (cov && typeof cov === 'object') {
    // Decoding validates every entry and enforces the size limits.
    const files = encodeCoverage(decodeCoverage(cov.files));
    const sources = (Array.isArray(cov.sources) ? cov.sources : [])
      .slice(0, 1000)
      .map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          format: COVERAGE_FORMAT_LIST.find(f => f === o.format) ?? 'lcov',
          path: str(o.path),
          files: Math.floor(num(o.files)),
          external: Math.floor(num(o.external)),
        };
      });
    if (sources.length || files.length) out.coverage = { sources, files };
  }
  return out;
}

function validateTest(raw: unknown): TestCase {
  const t = (raw ?? {}) as Record<string, unknown>;
  const status =
    (Object.keys(STATUS_SEVERITY) as TestStatus[]).find(s => s === t.status) ??
    'other';
  const suite = str(t.suite);
  const name = str(t.name) || '(unnamed)';
  const out: TestCase = {
    id: str(t.id, 2 * MAX_STR + 3) || (suite ? `${suite} › ${name}` : name),
    suite,
    name,
    status,
    durationMs: Math.round(num(t.durationMs)),
  };
  const file = str(t.file);
  if (file) out.file = file;
  const message = truncate(str(t.message, 4 * MAX_STR));
  if (message && status !== 'passed') out.message = message;
  if (t.flaky === true && status === 'passed') out.flaky = true;
  return out;
}

export function artifactName(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

export async function uploadArtifact(
  upload: Upload,
  prefix: string,
  retentionDays: number,
): Promise<string> {
  const dir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'standalone-stats-collect-'),
  );
  try {
    const file = join(dir, FILE);
    await writeFile(file, JSON.stringify(upload));
    const name = artifactName(prefix, upload.key);
    const client = new DefaultArtifactClient();
    await client.uploadArtifact(name, [file], dir, { retentionDays });
    return name;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download every upload artifact in the current run. `latest: true` lets
 * the artifact service drop older same-named artifacts (a re-run's upload
 * supersedes the failed attempt's); we also dedupe by key on attempt.
 */
export async function downloadUploads(prefix: string): Promise<Upload[]> {
  const client = new DefaultArtifactClient();
  const { artifacts } = await client.listArtifacts({ latest: true });
  // The PR report shares the default prefix but isn't an upload.
  const mine = artifacts.filter(
    a => a.name.startsWith(prefix) && a.name !== REPORT_ARTIFACT,
  );
  const root = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'standalone-stats-dl-'),
  );
  const uploads: Upload[] = [];
  try {
    for (const a of mine) {
      const path = join(root, String(a.id));
      await mkdir(path, { recursive: true });
      await client.downloadArtifact(a.id, { path });
      const files = await readdir(path);
      if (!files.includes(FILE)) {
        core.warning(`Artifact ${a.name} has no ${FILE}; skipping`);
        continue;
      }
      try {
        uploads.push(
          validateUpload(JSON.parse(await readFile(join(path, FILE), 'utf8'))),
        );
      } catch (err) {
        core.warning(`Artifact ${a.name}: ${(err as Error).message}; skipping`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return dedupe(uploads);
}

/** Keep one upload per key: the highest attempt (latest createdAt on ties). */
export function dedupe(uploads: Upload[]): Upload[] {
  const best = new Map<string, Upload>();
  for (const u of uploads) {
    const cur = best.get(u.key);
    if (
      !cur ||
      u.attempt > cur.attempt ||
      (u.attempt === cur.attempt && u.createdAt > cur.createdAt)
    )
      best.set(u.key, u);
  }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
}
