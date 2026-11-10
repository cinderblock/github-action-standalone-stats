import * as core from '@actions/core';
import { addedLines, type Diff } from './coverage/patch.js';

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

/** The compare API lists at most this many files across its pages. */
const COMPARE_FILE_CAP = 300;

/**
 * Lines added between `base` and `head` (three-dot: from their merge base),
 * per file, from the compare API. Removed files are skipped; renamed files
 * use their new name. Returns undefined if the comparison isn't available.
 */
export async function compareDiff(
  ref: RepoRef,
  base: string,
  head: string,
  opts: ApiOptions,
): Promise<Diff | undefined> {
  const files = new Map<string, Set<number>>();
  const omitted: string[] = [];
  let partial = false;
  let seen = 0;
  for (let page = 1; page <= 3; page++) {
    const { status, body } = await api<{
      files?: {
        filename: string;
        status: string;
        patch?: string;
        changes?: number;
      }[];
    }>(
      'GET',
      `/repos/${ref.owner}/${ref.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      undefined,
      opts,
    );
    if (status !== 200) {
      if (page === 1) {
        core.info(`No diff for patch coverage (compare API status ${status})`);
        return undefined;
      }
      partial = true;
      break;
    }
    const list = body.files ?? [];
    for (const f of list) {
      seen++;
      if (f.status === 'removed') continue;
      if (f.patch === undefined) {
        // Binary, or too large for the API to include.
        if (f.changes) omitted.push(f.filename);
        continue;
      }
      files.set(f.filename, addedLines(f.patch));
    }
    if (list.length < 100) break;
    if (seen >= COMPARE_FILE_CAP) partial = true;
  }
  return omitted.length ? { files, partial, omitted } : { files, partial };
}

/** A write the token isn't allowed to make (read-only token, fork PR, or
 *  missing `permissions:`), as opposed to a real failure. */
export class PermissionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function fail(what: string, status: number, body: unknown): never {
  const msg = (body as { message?: string } | undefined)?.message ?? '';
  const text = `${what}: status ${status}${msg ? ` (${msg})` : ''}`;
  // 403 "Resource not accessible by integration" is the read-only token;
  // 404 is what GitHub says for repos the token can't see at all.
  if (status === 403 || status === 404) throw new PermissionError(text, status);
  throw new Error(text);
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
  html_url: string;
}

/** Every comment on an issue or PR, oldest first (up to 3,000). */
export async function listComments(
  ref: RepoRef,
  issue: number,
  opts: ApiOptions,
): Promise<IssueComment[]> {
  const out: IssueComment[] = [];
  for (let page = 1; page <= 30; page++) {
    const { status, body } = await api<IssueComment[]>(
      'GET',
      `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments?per_page=100&page=${page}`,
      undefined,
      opts,
    );
    if (status !== 200) fail(`Listing comments on #${issue}`, status, body);
    out.push(...body);
    if (body.length < 100) break;
  }
  return out;
}

export async function createComment(
  ref: RepoRef,
  issue: number,
  text: string,
  opts: ApiOptions,
): Promise<IssueComment> {
  const { status, body } = await api<IssueComment>(
    'POST',
    `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments`,
    { body: text },
    opts,
  );
  if (status !== 201) fail(`Commenting on #${issue}`, status, body);
  return body;
}

export async function updateComment(
  ref: RepoRef,
  id: number,
  text: string,
  opts: ApiOptions,
): Promise<IssueComment> {
  const { status, body } = await api<IssueComment>(
    'PATCH',
    `/repos/${ref.owner}/${ref.name}/issues/comments/${id}`,
    { body: text },
    opts,
  );
  if (status !== 200) fail(`Updating comment ${id}`, status, body);
  return body;
}

export async function createStatus(
  ref: RepoRef,
  sha: string,
  s: {
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    description: string;
    target_url?: string;
  },
  opts: ApiOptions,
): Promise<void> {
  const { status, body } = await api(
    'POST',
    `/repos/${ref.owner}/${ref.name}/statuses/${encodeURIComponent(sha)}`,
    s,
    opts,
  );
  if (status !== 201) fail(`Setting status ${s.context}`, status, body);
}

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  event: string;
  head_sha: string;
  head_branch: string | null;
  head_repository: { full_name: string } | null;
  pull_requests: { number: number }[];
}

export async function getRun(
  ref: RepoRef,
  id: number,
  opts: ApiOptions,
): Promise<WorkflowRun> {
  const { status, body } = await api<WorkflowRun>(
    'GET',
    `/repos/${ref.owner}/${ref.name}/actions/runs/${id}`,
    undefined,
    opts,
  );
  if (status !== 200) fail(`Reading run ${id}`, status, body);
  return body;
}

export interface PullRequest {
  number: number;
  state: string;
  head: { sha: string };
}

export async function getPull(
  ref: RepoRef,
  n: number,
  opts: ApiOptions,
): Promise<PullRequest | undefined> {
  const { status, body } = await api<PullRequest>(
    'GET',
    `/repos/${ref.owner}/${ref.name}/pulls/${n}`,
    undefined,
    opts,
  );
  if (status === 404) return undefined;
  if (status !== 200) fail(`Reading PR #${n}`, status, body);
  return body;
}
