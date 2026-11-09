import * as core from '@actions/core';

export interface RepoRef {
  owner: string;
  name: string;
}

/** Parse `owner/name`. Throws on malformed input. */
export function parseRepo(slug: string): RepoRef {
  const m = slug.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m)
    throw new Error(
      `Invalid repo slug: ${JSON.stringify(slug)} (expected "owner/name")`,
    );
  return { owner: m[1]!, name: m[2]! };
}

export interface ApiOptions {
  token: string;
  apiUrl?: string;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body: unknown,
  {
    token,
    apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  }: ApiOptions,
): Promise<{ status: number; body: T }> {
  const url = `${apiUrl.replace(/\/+$/, '')}${path}`;
  core.debug(`${method} ${url}`);
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
  let parsed: T;
  try {
    parsed = (text ? JSON.parse(text) : undefined) as T;
  } catch {
    parsed = undefined as T;
  }
  return { status: res.status, body: parsed };
}

export interface RepoInfo {
  private: boolean;
  defaultBranch: string;
}

/** Repo metadata, or undefined if it doesn't exist (or isn't visible). */
export async function getRepo(
  ref: RepoRef,
  opts: ApiOptions,
): Promise<RepoInfo | undefined> {
  const { status, body } = await api<{
    private?: boolean;
    default_branch?: string;
  }>('GET', `/repos/${ref.owner}/${ref.name}`, undefined, opts);
  if (status === 404) return undefined;
  if (status !== 200)
    throw new Error(
      `Unexpected status ${status} reading ${ref.owner}/${ref.name}`,
    );
  return {
    private: !!body.private,
    defaultBranch: body.default_branch ?? 'main',
  };
}

export type PagesInfo =
  | { state: 'none' }
  | { state: 'unknown'; status: number }
  | {
      state: 'enabled';
      /** False only for access-controlled (Enterprise) Pages. */
      public: boolean;
      buildType?: string;
      source?: { branch: string; path: string };
      url?: string;
    };

export async function getPages(
  ref: RepoRef,
  opts: ApiOptions,
): Promise<PagesInfo> {
  const { status, body } = await api<{
    public?: boolean;
    build_type?: string;
    source?: { branch: string; path: string };
    html_url?: string;
  }>('GET', `/repos/${ref.owner}/${ref.name}/pages`, undefined, opts);
  if (status === 404) return { state: 'none' };
  if (status !== 200) return { state: 'unknown', status };
  const info: PagesInfo = { state: 'enabled', public: body.public !== false };
  if (body.build_type) info.buildType = body.build_type;
  if (body.source) info.source = body.source;
  if (body.html_url) info.url = body.html_url;
  return info;
}

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

/** Create a repo for a user or org owner. */
export async function createRepo(
  ref: RepoRef,
  opts: ApiOptions & { visibility: 'public' | 'private' },
): Promise<void> {
  const org = await isOrg(ref.owner, opts);
  const { status, body } = await api<{ message?: string }>(
    'POST',
    org ? `/orgs/${ref.owner}/repos` : '/user/repos',
    {
      name: ref.name,
      description:
        'Test and coverage stats, published by github-action-standalone-stats',
      private: opts.visibility === 'private',
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    },
    opts,
  );
  if (status >= 200 && status < 300) return;
  throw new Error(
    `Failed to create ${ref.owner}/${ref.name}: status ${status} ${body?.message ?? ''}`.trim(),
  );
}

/** Enable Pages from `branch` at the repo root. Best effort: a warning, not
 *  an error, since the owner may have configured Pages differently. */
export async function enablePages(
  ref: RepoRef,
  branch: string,
  opts: ApiOptions,
): Promise<void> {
  const { status } = await api(
    'POST',
    `/repos/${ref.owner}/${ref.name}/pages`,
    { source: { branch, path: '/' } },
    opts,
  );
  if (status === 201 || status === 204 || status === 409) return;
  core.warning(
    `Could not enable Pages on ${ref.owner}/${ref.name} (status ${status}). Enable it in Settings → Pages, source: branch ${branch}.`,
  );
}

/** Default Pages URL for a repo + subpath (no custom domain). */
export function defaultPagesUrl(ref: RepoRef, path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const suffix = trimmed ? `${trimmed}/` : '';
  if (ref.name.toLowerCase() === `${ref.owner.toLowerCase()}.github.io`)
    return `https://${ref.name}/${suffix}`;
  return `https://${ref.owner}.github.io/${ref.name}/${suffix}`;
}
