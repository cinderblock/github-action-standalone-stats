import * as core from '@actions/core';
import { mkdir } from 'node:fs/promises';
import { spawn } from './spawn.js';

interface Options {
  repoUrl: string;
  dir: string;
  branch: string;
  debug?: typeof core.debug;
}

/** Try to clone the given branch into `dir`. If the branch doesn't exist
 *  yet on the remote, initialize a fresh orphan branch in `dir` so that
 *  the caller can populate it and push back. */
export async function cloneOrOrphan({
  repoUrl,
  dir,
  branch,
  debug = core.debug,
}: Options): Promise<void> {
  debug(`Cloning ${repoUrl} branch=${branch} into ${dir}`);
  try {
    await spawn(
      'git',
      'clone',
      '--single-branch',
      '--branch',
      branch,
      '--depth',
      '1',
      '--',
      repoUrl,
      dir,
    );
    debug('Branch cloned');
    return;
  } catch {
    debug(`Branch ${branch} missing on remote — creating an orphan.`);
  }

  await mkdir(dir, { recursive: true });
  await spawn('git', { cwd: dir }, 'init', '--initial-branch=' + branch);
  await spawn('git', { cwd: dir }, 'remote', 'add', 'origin', repoUrl);
  // No commits yet; caller will populate and `git add . && git commit`.
  debug('Orphan branch initialized');
}
