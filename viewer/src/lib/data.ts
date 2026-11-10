/**
 * Data access. Everything is static JSON next to the app (`data/…`), fetched
 * once per page load and cached as promises, so React 19's `use()` can
 * suspend on them.
 */
import type {
  DetailFile,
  IndexFile,
  RunRecord,
  TestsIndex,
} from '../../../src/model.js';

const SCHEMA = 1;

export class DataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const cache = new Map<string, Promise<unknown>>();

function load<T>(path: string, check: (v: unknown) => v is T): Promise<T> {
  let p = cache.get(path) as Promise<T> | undefined;
  if (!p) {
    p = fetch(path, { cache: 'no-cache' }).then(async r => {
      if (!r.ok) throw new DataError(`${path}: HTTP ${r.status}`, r.status);
      const v: unknown = await r.json();
      if (!check(v))
        throw new DataError(
          `${path}: unsupported data (schema ${String((v as { schema?: unknown })?.schema)})`,
        );
      return v;
    });
    // Let a failed fetch be retried on the next navigation.
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

const schemaOk = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as { schema?: unknown }).schema === SCHEMA;

export const getIndex = () =>
  load('data/index.json', (v): v is IndexFile =>
    schemaOk(v) && Array.isArray((v as IndexFile).runs),
  );

export const getTests = () =>
  load('data/tests.json', (v): v is TestsIndex =>
    schemaOk(v) && Array.isArray((v as TestsIndex).runs),
  );

/** Only paths the publisher writes, so a crafted index can't point the
 *  viewer at arbitrary URLs. */
const RUN_PATH = /^data\/runs\/\d{4}\/\d{2}\/[\w.-]+\.json$/;
const DETAIL_PATH = /^data\/detail\/[\w.-]+\.json$/;

export function getRun(path: string) {
  if (!RUN_PATH.test(path))
    return Promise.reject(new DataError(`Bad run path ${path}`));
  return load(path, (v): v is RunRecord => schemaOk(v));
}

export function getDetail(path: string) {
  if (!DETAIL_PATH.test(path))
    return Promise.reject(new DataError(`Bad detail path ${path}`));
  return load(path, (v): v is DetailFile =>
    schemaOk(v) && Array.isArray((v as DetailFile).groups),
  );
}

/** Source text at a commit, from GitHub's raw host. Public repos only;
 *  resolves to `undefined` when it isn't reachable. */
export function getSource(
  repo: string,
  sha: string,
  path: string,
): Promise<string[] | undefined> {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  let p = cache.get(url) as Promise<string[] | undefined> | undefined;
  if (!p) {
    p = fetch(url)
      .then(r => (r.ok ? r.text() : undefined))
      .then(t => t?.replace(/\r\n?/g, '\n').split('\n'))
      .catch(() => undefined);
    cache.set(url, p);
  }
  return p;
}


const maybe = new Map<string, Promise<DetailFile | undefined>>();

/** Like `getDetail`, but a pruned (404) detail file resolves to undefined. */
export function getDetailIfKept(path: string): Promise<DetailFile | undefined> {
  let p = maybe.get(path);
  if (!p) {
    p = getDetail(path).catch((e: unknown) => {
      if (e instanceof DataError && e.status === 404) return undefined;
      maybe.delete(path);
      throw e;
    });
    maybe.set(path, p);
  }
  return p;
}
