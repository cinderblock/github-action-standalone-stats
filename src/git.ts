import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Git plumbing for the stats branch. Auth never goes on the command line or
 * into a remote URL: it's an `http.extraheader` passed through GIT_CONFIG_*
 * env vars (what actions/checkout does), so it can't leak into `.git/config`,
 * process listings, or error messages.
 */

export interface Remote {
  /** Clone URL without credentials, e.g. https://github.com/o/r.git, or a
   *  local path in tests. */
  url: string;
  token?: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

function env(remote: Remote): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (remote.token && /^https?:\/\//.test(remote.url)) {
    const origin = new URL(remote.url).origin;
    const basic = Buffer.from(`x-access-token:${remote.token}`).toString(
      'base64',
    );
    e.GIT_CONFIG_COUNT = '1';
    e.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    e.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return e;
}

export function git(
  remote: Remote,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  core.debug(`git ${args.join(' ')}${cwd ? ` (in ${cwd})` : ''}`);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: env(remote), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          reject(
            new GitError(
              `git ${args[0]} failed (exit ${code ?? '?'}): ${stderr.trim() || err.message}`,
              stderr,
              code,
            ),
          );
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** True if `branch` exists on the remote. Throws on auth/network errors
 *  instead of mistaking them for "missing". */
export async function remoteHasBranch(
  remote: Remote,
  branch: string,
): Promise<boolean> {
  const { stdout } = await git(remote, [
    'ls-remote',
    '--heads',
    '--',
    remote.url,
    `refs/heads/${branch}`,
  ]);
  return stdout.trim().length > 0;
}

/** Shallow-clone `branch` into a new temp dir, or start an orphan there if
 *  the branch doesn't exist yet. Returns the dir and whether it was new. */
export async function checkout(
  remote: Remote,
  branch: string,
): Promise<{ dir: string; fresh: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'standalone-stats-'));
  if (await remoteHasBranch(remote, branch)) {
    await git(remote, [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      branch,
      '--',
      remote.url,
      dir,
    ]);
    return { dir, fresh: false };
  }
  await git(remote, ['init', '--quiet', `--initial-branch=${branch}`], dir);
  await git(remote, ['remote', 'add', 'origin', remote.url], dir);
  return { dir, fresh: true };
}

export interface Author {
  name: string;
  email: string;
}

/** Stage everything and commit. Returns false if nothing changed. */
export async function commitAll(
  remote: Remote,
  dir: string,
  message: string,
  author: Author,
): Promise<boolean> {
  await git(remote, ['add', '--all', '.'], dir);
  try {
    await git(remote, ['diff', '--cached', '--quiet'], dir);
    return false;
  } catch (err) {
    if (!(err instanceof GitError) || err.code !== 1) throw err;
  }
  await git(
    remote,
    [
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      message,
    ],
    dir,
  );
  return true;
}

/** Push failures that mean "someone else pushed first": retry from a fresh
 *  clone. Anything else (auth, protection rules) is fatal. */
export function isRaceRejection(err: unknown): boolean {
  if (!(err instanceof GitError)) return false;
  return /\[rejected\]|non-fast-forward|fetch first|cannot lock ref|incorrect old value|stale info/i.test(
    err.stderr,
  );
}

export interface PublishOptions {
  remote: Remote;
  branch: string;
  message: string;
  author: Author;
  /** Write this run's changes into a fresh checkout. Called again from
   *  scratch on every retry, so it must only depend on what's in `dir`. */
  apply: (dir: string, fresh: boolean) => Promise<void>;
  attempts?: number;
  /** Base backoff in ms; doubled per attempt, with jitter. */
  backoffMs?: number;
}

export interface PublishResult {
  committed: boolean;
  attempts: number;
  /** Checkout left in place for the caller (e.g. to copy the site out).
   *  Caller must remove it. */
  dir: string;
}

/**
 * Clone → apply → commit → push, retrying on a lost race. Every attempt
 * starts from a fresh clone of the remote tip and re-applies, so a retry
 * never needs a merge: our writes are per-run files plus indexes that
 * `apply` rebuilds from whatever is there. That's the compare-and-swap a
 * branch gives us for free (a push that isn't a fast-forward is rejected).
 */
export async function publishBranch(
  opts: PublishOptions,
): Promise<PublishResult> {
  const attempts = opts.attempts ?? 6;
  const base = opts.backoffMs ?? 1000;
  for (let i = 1; ; i++) {
    const { dir, fresh } = await checkout(opts.remote, opts.branch);
    let keep = false;
    try {
      await opts.apply(dir, fresh);
      if (!(await commitAll(opts.remote, dir, opts.message, opts.author))) {
        keep = true;
        return { committed: false, attempts: i, dir };
      }
      try {
        await git(
          opts.remote,
          ['push', '--quiet', 'origin', `HEAD:refs/heads/${opts.branch}`],
          dir,
        );
        keep = true;
        return { committed: true, attempts: i, dir };
      } catch (err) {
        if (!isRaceRejection(err) || i >= attempts) throw err;
        const wait = base * 2 ** (i - 1) * (0.5 + Math.random());
        core.info(
          `Push to ${opts.branch} lost a race (attempt ${i}/${attempts}); retrying in ${Math.round(wait)} ms`,
        );
        await new Promise(r => setTimeout(r, wait));
      }
    } finally {
      if (!keep)
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
