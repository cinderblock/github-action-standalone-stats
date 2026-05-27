import * as core from '@actions/core';

const API = 'https://api.github.com';

interface RepoRef {
  owner: string;
  name: string;
}

/** Parse `owner/name` into its parts. Throws on malformed input. */
export function parseRepo(slug: string): RepoRef {
  const m = slug.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m)
    throw new Error(
      `Invalid repo slug: ${JSON.stringify(slug)} (expected "owner/name")`,
    );
  return { owner: m[1]!, name: m[2]! };
}

interface ApiOptions {
  token: string;
  debug?: typeof core.debug;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body: unknown,
  { token, debug = core.debug }: ApiOptions,
): Promise<{ status: number; body: T }> {
  const url = `${API}${path}`;
  debug(`${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-action-standalone-stats',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, body: parsed };
}

/** True if the repo exists and is accessible with the given token. */
export async function repoExists(
  ref: RepoRef,
  opts: ApiOptions,
): Promise<boolean> {
  const { status } = await api(
    'GET',
    `/repos/${ref.owner}/${ref.name}`,
    undefined,
    opts,
  );
  if (status === 200) return true;
  if (status === 404) return false;
  throw new Error(
    `Unexpected status ${status} checking ${ref.owner}/${ref.name}`,
  );
}

/** True if `owner` is an organization (vs. a user). */
async function isOrg(owner: string, opts: ApiOptions): Promise<boolean> {
  const { status, body } = await api<{ type?: string }>(
    'GET',
    `/users/${owner}`,
    undefined,
    opts,
  );
  if (status !== 200)
    throw new Error(`Failed to look up ${owner}: status ${status}`);
  return body.type === 'Organization';
}

interface CreateRepoOptions extends ApiOptions {
  visibility: 'public' | 'private';
  description?: string;
}

/** Create a new repo. Handles both user and org owners. Idempotent: if the
 *  repo already exists, returns without error. */
export async function createRepo(
  ref: RepoRef,
  opts: CreateRepoOptions,
): Promise<void> {
  if (await repoExists(ref, opts)) return;

  const org = await isOrg(ref.owner, opts);
  const path = org ? `/orgs/${ref.owner}/repos` : '/user/repos';
  const body = {
    name: ref.name,
    description:
      opts.description ?? 'Auto-created by github-action-standalone-stats',
    private: opts.visibility === 'private',
    auto_init: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  };
  const { status, body: result } = await api<{ message?: string }>(
    'POST',
    path,
    body,
    opts,
  );
  if (status >= 200 && status < 300) {
    (opts.debug ?? core.debug)(`Created repo ${ref.owner}/${ref.name}`);
    return;
  }
  throw new Error(
    `Failed to create ${ref.owner}/${ref.name}: status ${status} ${result?.message ?? ''}`.trim(),
  );
}

/** Enable GitHub Pages on the given repo+branch+path. Idempotent: if Pages
 *  is already configured, returns without error. Failure is logged as a
 *  warning rather than thrown, since the user may have configured Pages
 *  manually with a non-default source. */
export async function ensurePages(
  ref: RepoRef,
  branch: string,
  path: string,
  opts: ApiOptions,
): Promise<void> {
  const body = {
    source: { branch, path: path || '/' },
  };
  const { status } = await api(
    'POST',
    `/repos/${ref.owner}/${ref.name}/pages`,
    body,
    opts,
  );
  if (status === 201 || status === 204) {
    (opts.debug ?? core.debug)(`Enabled Pages on ${ref.owner}/${ref.name}`);
    return;
  }
  if (status === 409) {
    (opts.debug ?? core.debug)(
      `Pages already configured on ${ref.owner}/${ref.name}`,
    );
    return;
  }
  core.warning(
    `Could not enable Pages on ${ref.owner}/${ref.name} (status ${status}). ` +
      `If you've configured Pages manually, this is expected. Otherwise enable ` +
      `Pages in repo Settings → Pages, source: branch ${branch}, path ${path || '/'}.`,
  );
}

/** Compute the URL that the rendered report will live at, given that the
 *  pages branch is set up the standard way. */
export function pagesUrl(ref: RepoRef, path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const suffix = trimmed ? `${trimmed}/` : '';
  return `https://${ref.owner}.github.io/${ref.name}/${suffix}`;
}
