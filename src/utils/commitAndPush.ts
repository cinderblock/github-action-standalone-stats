import * as core from '@actions/core';
import { spawn, exec } from './spawn.js';

interface Options {
  branch: string;
  dir: string;
  message: string;
  name: string;
  email: string;
  /** If true, push an empty commit when nothing changed. Default: skip both
   *  commit and push when there are no staged changes. */
  commitUnchanged?: boolean;
  debug?: typeof core.debug;
}

/** Stage, commit, and push the contents of `dir`. Returns true if a commit
 *  was created, false if there was nothing to commit and `commitUnchanged`
 *  was false. */
export async function commitAndPush({
  branch,
  dir,
  message,
  name,
  email,
  commitUnchanged = false,
  debug = core.debug,
}: Options): Promise<boolean> {
  debug('Adding all files');
  await spawn('git', { cwd: dir }, 'add', '.');

  if (!commitUnchanged && !(await hasStagedChanges(dir))) {
    debug('No staged changes — skipping commit/push.');
    return false;
  }

  debug('Committing');
  const commitArgs: string[] = [
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '--message',
    message,
  ];
  if (commitUnchanged) commitArgs.push('--allow-empty');
  await spawn('git', { cwd: dir }, ...commitArgs);

  debug('Pushing');
  await spawn(
    'git',
    { cwd: dir },
    'push',
    'origin',
    `HEAD:refs/heads/${branch}`,
  );
  return true;
}

/** True iff `git add .` produced any staged differences. */
async function hasStagedChanges(dir: string): Promise<boolean> {
  try {
    await exec(`git -C ${JSON.stringify(dir)} diff --cached --quiet`, null);
    return false;
  } catch {
    return true;
  }
}
