import { describe, it, expect } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, exec } from './spawn.js';
import { cloneOrOrphan } from './clone.js';
import { commitAndPush } from './commitAndPush.js';

async function initBareRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sst-bare-'));
  await spawn('git', { cwd: dir }, 'init', '--bare', '--initial-branch=main');
  return dir;
}

const author = {
  name: 'Test',
  email: 'test@example.com',
};

describe('cloneOrOrphan + commitAndPush', () => {
  it('initializes an orphan branch on first run and pushes content', async () => {
    const bare = await initBareRepo();
    const work = await mkdtemp(join(tmpdir(), 'sst-work-'));

    try {
      await cloneOrOrphan({ repoUrl: bare, dir: work, branch: 'allure-data' });

      await writeFile(join(work, 'hello.txt'), 'first run', 'utf8');
      const committed = await commitAndPush({
        dir: work,
        branch: 'allure-data',
        message: 'first',
        name: author.name,
        email: author.email,
      });
      expect(committed).toBe(true);

      // Verify the bare repo now has that branch with our file.
      const verify = await mkdtemp(join(tmpdir(), 'sst-verify-'));
      try {
        await spawn(
          'git',
          'clone',
          '--single-branch',
          '--branch',
          'allure-data',
          '--',
          bare,
          verify,
        );
        const files = await readdir(verify);
        expect(files).toContain('hello.txt');
      } finally {
        await rm(verify, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      await rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('clones an existing branch on subsequent runs and adds another commit', async () => {
    const bare = await initBareRepo();
    const first = await mkdtemp(join(tmpdir(), 'sst-first-'));
    const second = await mkdtemp(join(tmpdir(), 'sst-second-'));

    try {
      // Run 1.
      await cloneOrOrphan({ repoUrl: bare, dir: first, branch: 'allure-data' });
      await writeFile(join(first, 'r1.txt'), 'first', 'utf8');
      await commitAndPush({
        dir: first,
        branch: 'allure-data',
        message: 'r1',
        name: author.name,
        email: author.email,
      });

      // Run 2 — clones the existing branch.
      await cloneOrOrphan({
        repoUrl: bare,
        dir: second,
        branch: 'allure-data',
      });
      const filesAfterClone = await readdir(second);
      expect(filesAfterClone).toContain('r1.txt');

      await writeFile(join(second, 'r2.txt'), 'second', 'utf8');
      await commitAndPush({
        dir: second,
        branch: 'allure-data',
        message: 'r2',
        name: author.name,
        email: author.email,
      });

      // Verify both files are on the branch.
      const verify = await mkdtemp(join(tmpdir(), 'sst-verify-'));
      try {
        await spawn(
          'git',
          'clone',
          '--single-branch',
          '--branch',
          'allure-data',
          '--',
          bare,
          verify,
        );
        const files = await readdir(verify);
        expect(files).toContain('r1.txt');
        expect(files).toContain('r2.txt');
      } finally {
        await rm(verify, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await rm(first, { recursive: true, force: true }).catch(() => {});
      await rm(second, { recursive: true, force: true }).catch(() => {});
      await rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('skips push when nothing changed', async () => {
    const bare = await initBareRepo();
    const first = await mkdtemp(join(tmpdir(), 'sst-first-'));
    const second = await mkdtemp(join(tmpdir(), 'sst-second-'));

    try {
      await cloneOrOrphan({ repoUrl: bare, dir: first, branch: 'allure-data' });
      await writeFile(join(first, 'r1.txt'), 'first', 'utf8');
      await commitAndPush({
        dir: first,
        branch: 'allure-data',
        message: 'r1',
        name: author.name,
        email: author.email,
      });

      // Re-clone and try to commit with no changes — should be a no-op.
      await cloneOrOrphan({
        repoUrl: bare,
        dir: second,
        branch: 'allure-data',
      });
      const committed = await commitAndPush({
        dir: second,
        branch: 'allure-data',
        message: 'noop',
        name: author.name,
        email: author.email,
      });
      expect(committed).toBe(false);

      // Confirm only one commit on the branch.
      const { stdout } = await exec(
        `git --git-dir=${JSON.stringify(bare)} rev-list --count allure-data`,
        null,
      );
      expect(stdout.trim()).toBe('1');
    } finally {
      await rm(first, { recursive: true, force: true }).catch(() => {});
      await rm(second, { recursive: true, force: true }).catch(() => {});
      await rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  });
});
