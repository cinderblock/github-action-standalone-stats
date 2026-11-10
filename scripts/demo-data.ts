/**
 * Writes a realistic stats directory for developing and testing the viewer:
 * `bun scripts/demo-data.ts [outDir]` (default `viewer/.demo`).
 *
 * It drives the real publish pipeline (`buildCoverage`, `buildRecord`,
 * `applyRun`) over the serialport bindings-cpp coverage fixtures (nyc lcov
 * for the TypeScript, Cobertura for the C++, one job per OS), with seeded
 * noise: ~40 master runs over six weeks plus PR runs, real failures, flaky
 * tests, a job that sometimes doesn't run (carried forward) and patch
 * coverage. Output is deterministic.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity } from '../src/collect/gather.js';
import { readCobertura } from '../src/coverage/cobertura.js';
import { readLcov } from '../src/coverage/lcov.js';
import {
  encodeCoverage,
  mergeCoverage,
  type Coverage,
} from '../src/coverage/model.js';
import { resolveRaw } from '../src/coverage/read.js';
import type { Diff } from '../src/coverage/patch.js';
import {
  SCHEMA,
  type RunRecord,
  type TestCase,
  type TestStatus,
  type Upload,
} from '../src/model.js';
import { buildCoverage, parseCarryforward } from '../src/publish/coverage.js';
import { buildRecord } from '../src/publish/merge.js';
import { applyRun, readDetail } from '../src/publish/store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? join(root, 'viewer', '.demo'));

const REPO = 'cinderblock/bindings-cpp';
/** The fixtures' real commit, so the newest run's source view resolves. */
const REAL_SHA = '81ac7c5b7175bbcc392ec3ff3e166db22f601ec6';

// Seeded PRNG (mulberry32): the same data every time.
let seed = 0x5eed;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
const hex = (n: number) =>
  Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join(
    '',
  );

const OSES = {
  ubuntu: { name: 'Linux', ws: '/home/runner/work/bindings-cpp/bindings-cpp' },
  macos: { name: 'macOS', ws: '/Users/runner/work/bindings-cpp/bindings-cpp' },
  windows: { name: 'Windows', ws: 'D:\\a\\bindings-cpp\\bindings-cpp' },
} as const;
type Os = keyof typeof OSES;

const fx = (name: string) =>
  readFileSync(join(root, 'test', 'fixtures', 'coverage', name), 'utf8');
const never = () => false;

function baseCoverage(os: Os): Coverage {
  const ws = OSES[os].ws;
  const ts = resolveRaw(readLcov(fx(`${os}.lcov.info`)), ws, never).coverage;
  const cpp = resolveRaw(
    readCobertura(fx(`${os}.cobertura.xml`)),
    ws,
    never,
  ).coverage;
  return mergeCoverage(mergeCoverage(new Map(), ts), cpp);
}
const BASE = Object.fromEntries(
  (Object.keys(OSES) as Os[]).map(os => [os, baseCoverage(os)]),
) as Record<Os, Coverage>;

/** A copy with each covered line dropped to 0 hits with probability `p`, and
 *  taken branches untaken with the same probability. */
function degrade(cov: Coverage, p: number): Coverage {
  const outCov: Coverage = new Map();
  for (const [path, file] of cov) {
    const f = new Map();
    for (const [n, l] of file) {
      const hits = l.hits > 0 && rand() < p ? 0 : l.hits;
      const br = l.br?.replace(/1/g, () => (rand() < p ? '0' : '1'));
      f.set(n, br === undefined ? { hits } : { hits, br });
    }
    outCov.set(path, f);
  }
  return outCov;
}

// Synthetic test suite: stable names, a few with personalities.
interface DemoTest {
  suite: string;
  name: string;
  file: string;
  ms: number;
  flaky?: number;
  /** Fails on runs in [from, to). */
  broken?: [number, number];
  /** Only on some OSes. */
  only?: Os[];
  slowdown?: number;
}
const TESTS: DemoTest[] = [];
const SUITES: [string, string, string[]][] = [
  [
    'bindings',
    'test/bindings.test.ts',
    [
      'opens a port',
      'closes a port',
      'reads bytes',
      'writes bytes',
      'drains',
      'flushes',
      'sets baud rate',
      'gets status',
      'sets DTR/RTS',
      'rejects bad paths',
    ],
  ],
  [
    'list',
    'test/list.test.ts',
    [
      'lists ports',
      'includes vendor ids',
      'handles no ports',
      'parses udev output',
      'parses ioreg output',
    ],
  ],
  [
    'poller',
    'test/poller.test.ts',
    ['polls readable', 'polls writable', 'stops on close', 'reports errors'],
  ],
  [
    'darwin',
    'test/darwin.test.ts',
    ['custom baud rates', 'low latency', 'IOSSIOSPEED'],
  ],
  [
    'linux',
    'test/linux.test.ts',
    ['custom baud rates', 'low latency', 'RS485 mode', 'termios2'],
  ],
  [
    'win32',
    'test/win32.test.ts',
    ['COM port names', 'overlapped reads', 'timeouts', 'friendly names'],
  ],
  [
    'stream',
    'test/stream.test.ts',
    [
      'pipes data',
      'backpressure',
      'emits close',
      'emits error',
      'pause and resume',
      'highWaterMark',
    ],
  ],
  [
    'parsers › readline',
    'test/parsers/readline.test.ts',
    ['splits on newline', 'custom delimiter', 'encoding', 'includeDelimiter'],
  ],
  [
    'parsers › delimiter',
    'test/parsers/delimiter.test.ts',
    ['splits', 'empty chunks', 'large buffers'],
  ],
];
for (const [suite, file, names] of SUITES)
  for (const name of names)
    TESTS.push({ suite, name, file, ms: 2 + Math.floor(rand() * 60) });
const find = (suite: string, name: string) =>
  TESTS.find(t => t.suite === suite && t.name === name)!;
find('stream', 'backpressure').flaky = 0.18;
find('win32', 'overlapped reads').flaky = 0.12;
find('poller', 'reports errors').flaky = 0.08;
find('bindings', 'drains').broken = [22, 26];
find('list', 'parses udev output').broken = [33, 34];
find('bindings', 'opens a port').slowdown = 12;
for (const t of TESTS)
  if (t.suite === 'darwin') t.only = ['macos'];
  else if (t.suite === 'linux') t.only = ['ubuntu'];
  else if (t.suite === 'win32') t.only = ['windows'];

function testsFor(os: Os, run: number): TestCase[] {
  const out: TestCase[] = [];
  for (const t of TESTS) {
    if (t.only && !t.only.includes(os)) continue;
    let status: TestStatus = 'passed';
    let message: string | undefined;
    let flaky: boolean | undefined;
    if (t.broken && run >= t.broken[0] && run < t.broken[1]) {
      status = 'failed';
      message = `AssertionError: expected 0 to be 1\n    at ${t.file}:${20 + (t.name.length % 30)}:11`;
    } else if (t.flaky && rand() < t.flaky) {
      if (rand() < 0.5) flaky = true;
      else {
        status = 'failed';
        message = `Error: Timed out after 5000 ms\n    at ${t.file}:${40 + (t.name.length % 20)}:5`;
      }
    } else if (
      t.suite === 'linux' &&
      t.name === 'RS485 mode' &&
      os === 'ubuntu'
    )
      status = 'skipped';
    const ms = Math.round(
      t.ms * (0.8 + rand() * 0.4) + (t.slowdown ? (t.slowdown * run) / 4 : 0),
    );
    const tc: TestCase = {
      id: `${t.suite} › ${t.name}`,
      suite: t.suite,
      name: t.name,
      file: t.file,
      status,
      durationMs: ms,
    };
    if (message) tc.message = message;
    if (flaky) tc.flaky = flaky;
    out.push(tc);
  }
  return out;
}

function upload(os: Os, run: number, p: number): Upload {
  const id = identity('test', { os: `${os}-latest`, node: '24.x' }, '');
  const cov = degrade(BASE[os], p);
  const tests = testsFor(os, run);
  return {
    schema: SCHEMA,
    key: id.key,
    label: id.label,
    job: 'test',
    dims: { ...id.dims, 'runner.os': OSES[os].name },
    flags: [OSES[os].name],
    attempt: 1,
    createdAt: new Date().toISOString(),
    sources: [{ format: 'junit', path: 'junit.xml', tests: tests.length }],
    tests,
    coverage: {
      sources: [
        { format: 'lcov', path: 'coverage/lcov.info', files: 6, external: 0 },
        {
          format: 'cobertura',
          path: 'coverage/cpp.xml',
          files: 4,
          external: 3,
        },
      ],
      files: encodeCoverage(cov),
    },
  };
}

/** A diff touching a few random coverable lines of a few files. */
function demoDiff(cov: Coverage): Diff {
  const files = new Map<string, Set<number>>();
  const paths = [...cov.keys()];
  for (let i = 0; i < 3; i++) {
    const path = pick(paths);
    const lines = [...cov.get(path)!.keys()];
    const start = Math.floor(rand() * Math.max(1, lines.length - 15));
    files.set(
      path,
      new Set(lines.slice(start, start + 4 + Math.floor(rand() * 12))),
    );
  }
  return { files, partial: false };
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const START = Date.parse('2026-09-28T17:00:00Z');
const RUNS = 40;
let runId = 41000000000;
let prevSha: string | undefined;
let lastRecord: RunRecord | undefined;
const opts = {
  repo: REPO,
  window: 100,
  detailWindow: 50,
  generator: { name: 'github-action-standalone-stats', version: 'demo' },
};
const carry = parseCarryforward('true');

for (let i = 0; i < RUNS; i++) {
  const isPr = i % 7 === 3 || i % 11 === 5;
  const time = new Date(
    START + i * 26 * 3600_000 + Math.floor(rand() * 3600_000),
  );
  const sha = i === RUNS - 1 ? REAL_SHA : hex(40);
  // Coverage climbs over the weeks, with a dip in the middle.
  const p = Math.max(0.01, 0.16 - i * 0.0035 + (i > 18 && i < 23 ? 0.05 : 0));
  const oses = (Object.keys(OSES) as Os[]).filter(
    os => !(os === 'macos' && i % 9 === 4),
  );
  const uploads = oses.map(os => upload(os, i, p));
  runId += 1 + Math.floor(rand() * 4000);
  const key = `${runId}-1`;
  const prNumber = 40 + i;
  const commit = isPr
    ? {
        sha,
        ref: `refs/pull/${prNumber}/merge`,
        branch: pick(['feature/rs485', 'fix/windows-timeouts', 'deps']),
        event: 'pull_request',
        pr: prNumber,
      }
    : { sha, ref: 'refs/heads/main', branch: 'main', event: 'push' };

  const baselineDetail = lastRecord && (await readDetail(out, lastRecord));
  const merged = mergeCoverage(new Map(), BASE.ubuntu);
  const cov = buildCoverage(uploads, {
    key,
    sha,
    components: [],
    carryforward: carry,
    ...(baselineDetail ? { baselineDetail } : {}),
    ...(prevSha ? { diff: { diff: demoDiff(merged), base: prevSha } } : {}),
  })!;
  const { record, tests } = buildRecord(uploads, {
    run: {
      id: runId,
      attempt: 1,
      number: 300 + i,
      workflow: 'Test',
      url: `https://github.com/${REPO}/actions/runs/${runId}`,
    },
    commit,
    now: time,
    coverage: cov,
  });
  await applyRun(out, record, tests, { ...opts, detail: cov.detail });
  if (!isPr) {
    prevSha = sha;
    lastRecord = record;
  }
}
console.log(`Demo stats for ${RUNS} runs written to ${out}`);
