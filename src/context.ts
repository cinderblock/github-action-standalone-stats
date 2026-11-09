import { readFileSync } from 'node:fs';
import type { CommitInfo, RunInfo } from './model.js';

type Env = Record<string, string | undefined>;

export interface Context {
  repo: string;
  serverUrl: string;
  run: RunInfo;
  commit: CommitInfo;
  defaultBranch?: string;
  /** For pull requests: the branch the PR targets. */
  baseBranch?: string;
  /** Commit to diff against for patch coverage: the PR's base (the compare
   *  API diffs from the merge base), or the previous tip for a push. */
  patchBase?: string;
  /** True when the event came from a fork, whose token is read-only. */
  fromFork: boolean;
  workspace: string;
  job: string;
  runnerOs?: string;
}

function readEvent(path: string | undefined): Record<string, any> {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}

export function readContext(env: Env = process.env): Context {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo)
    throw new Error(
      'GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.',
    );
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(
    /\/+$/,
    '',
  );
  const event = env.GITHUB_EVENT_NAME || 'unknown';
  const payload = readEvent(env.GITHUB_EVENT_PATH);
  const runId = Number(env.GITHUB_RUN_ID || 0);
  const pr = payload.pull_request as Record<string, any> | undefined;

  const run: RunInfo = {
    id: runId,
    attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    number: Number(env.GITHUB_RUN_NUMBER || 0),
    workflow: env.GITHUB_WORKFLOW || '',
    url: `${serverUrl}/${repo}/actions/runs/${runId}`,
  };

  const ref = env.GITHUB_REF || '';
  const commit: CommitInfo = {
    // On pull_request, GITHUB_SHA is GitHub's merge commit; the PR head is
    // what people recognize.
    sha: (pr?.head?.sha as string | undefined) || env.GITHUB_SHA || '',
    ref,
    event,
  };
  const branch = pr
    ? env.GITHUB_HEAD_REF || pr.head?.ref
    : ref.startsWith('refs/heads/')
      ? ref.slice(11)
      : undefined;
  if (branch) commit.branch = branch;
  if (pr?.number) commit.pr = Number(pr.number);

  const ctx: Context = {
    repo,
    serverUrl,
    run,
    commit,
    fromFork:
      !!pr &&
      pr.head?.repo?.full_name !== undefined &&
      pr.head.repo.full_name !== repo,
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
    job: env.GITHUB_JOB || 'job',
  };
  const defaultBranch = payload.repository?.default_branch as
    | string
    | undefined;
  if (defaultBranch) ctx.defaultBranch = defaultBranch;
  const base = env.GITHUB_BASE_REF || (pr?.base?.ref as string | undefined);
  if (base) ctx.baseBranch = base;
  if (env.RUNNER_OS) ctx.runnerOs = env.RUNNER_OS;
  const patchBase = pr
    ? (pr.base?.sha as string | undefined)
    : event === 'push'
      ? (payload.before as string | undefined)
      : undefined;
  // A push that creates a branch has `before` all zeros.
  if (patchBase && /^[0-9a-f]{7,64}$/i.test(patchBase) && !/^0+$/.test(patchBase))
    ctx.patchBase = patchBase;
  return ctx;
}

export type RecordMode = 'auto' | 'always' | 'never';

export function parseRecordMode(raw: string): RecordMode {
  const v = raw.trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (v === 'always' || v === 'true') return 'always';
  if (v === 'never' || v === 'false') return 'never';
  throw new Error(
    `Invalid record: ${JSON.stringify(raw)} (expected auto, always or never)`,
  );
}

const RECORDED_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);

/** `auto` records the default branch's own history: pushes, schedules and
 *  manual runs on it. PRs only get a comparison against it. */
export function shouldRecord(mode: RecordMode, ctx: Context): boolean {
  if (mode !== 'auto') return mode === 'always';
  if (!RECORDED_EVENTS.has(ctx.commit.event)) return false;
  return !!ctx.defaultBranch && ctx.commit.branch === ctx.defaultBranch;
}
