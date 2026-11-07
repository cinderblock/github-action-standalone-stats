import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkout,
  commitAll,
  git,
  GitError,
  isRaceRejection,
  publishBranch,
  remoteHasBranch,
  type Remote,
} from '../src/git.js';

const author = { name: 'Test', email: 'test@example.com' };

async function bare(): Promise<Remote> {
  const dir = await mkdtemp(join(tmpdir(), 'sst-bare-'));
  await git(
    { url: dir },
    ['init', '--quiet', '--bare', '--initial-branch=main'],
    dir,
  );
  return { url: dir };
}

async function filesOn(remote: Remote, branch: string): Promise<string[]> {
  const { stdout } = await git(remote, [
    '--git-dir',
    remote.url,
    'ls-tree',
    '-r',
    '--name-only',
    branch,
  ]);
  return stdout.trim().split('\n').filter(Boolean).sort();
}

describe('git', () => {
  it('creates the branch on first publish, then appends', async () => {
    const remote = await bare();
    try {
      expect(await remoteHasBranch(remote, 'gh-pages')).toBe(false);
      const first = await publishBranch({
        remote,
        branch: 'gh-pages',
        message: 'one',
        author,
        apply: async (dir, fresh) => {
          expect(fresh).toBe(true);
          await writeFile(join(dir, 'a.txt'), 'a');
        },
      });
      expect(first.committed).toBe(true);
      await rm(first.dir, { recursive: true, force: true });

      const second = await publishBranch({
        remote,
        branch: 'gh-pages',
        message: 'two',
        author,
        apply: async (dir, fresh) => {
          expect(fresh).toBe(false);
          await writeFile(join(dir, 'b.txt'), 'b');
        },
      });
      await rm(second.dir, { recursive: true, force: true });
      expect(await filesOn(remote, 'gh-pages')).toEqual(['a.txt', 'b.txt']);
    } finally {
      await rm(remote.url, { recursive: true, force: true });
    }
  });

  it('skips the commit when nothing changed', async () => {
    const remote = await bare();
    try {
      const write = async (dir: string) =>
        writeFile(join(dir, 'same.txt'), 'x');
      const a = await publishBranch({
        remote,
        branch: 'b',
        message: 'm',
        author,
        apply: write,
      });
      const b = await publishBranch({
        remote,
        branch: 'b',
        message: 'm',
        author,
        apply: write,
      });
      expect([a.committed, b.committed]).toEqual([true, false]);
      await rm(a.dir, { recursive: true, force: true });
      await rm(b.dir, { recursive: true, force: true });
    } finally {
      await rm(remote.url, { recursive: true, force: true });
    }
  });

  it('retries from a fresh clone after losing a push race, keeping both writes', async () => {
    const remote = await bare();
    try {
      await publishBranch({
        remote,
        branch: 'gh-pages',
        message: 'seed',
        author,
        apply: d => writeFile(join(d, 'seed.txt'), 's'),
      }).then(r => rm(r.dir, { recursive: true, force: true }));

      let calls = 0;
      const result = await publishBranch({
        remote,
        branch: 'gh-pages',
        message: 'mine',
        author,
        backoffMs: 1,
        apply: async dir => {
          calls++;
          if (calls === 1) {
            // Another run pushes between our clone and our push.
            const other = await checkout(remote, 'gh-pages');
            await writeFile(join(other.dir, 'theirs.txt'), 't');
            await commitAll(remote, other.dir, 'theirs', author);
            await git(
              remote,
              ['push', '--quiet', 'origin', 'HEAD:refs/heads/gh-pages'],
              other.dir,
            );
            await rm(other.dir, { recursive: true, force: true });
          }
          await writeFile(join(dir, 'mine.txt'), 'm');
        },
      });
      await rm(result.dir, { recursive: true, force: true });
      expect(calls).toBe(2);
      expect(result.attempts).toBe(2);
      expect(await filesOn(remote, 'gh-pages')).toEqual([
        'mine.txt',
        'seed.txt',
        'theirs.txt',
      ]);
    } finally {
      await rm(remote.url, { recursive: true, force: true });
    }
  });

  it('cleans up temp checkouts when apply throws', async () => {
    const remote = await bare();
    try {
      let seen = '';
      await expect(
        publishBranch({
          remote,
          branch: 'x',
          message: 'm',
          author,
          apply: async dir => {
            seen = dir;
            throw new Error('nope');
          },
        }),
      ).rejects.toThrow('nope');
      await expect(readdir(seen)).rejects.toThrow();
    } finally {
      await rm(remote.url, { recursive: true, force: true });
    }
  });

  it('classifies race rejections', () => {
    expect(
      isRaceRejection(
        new GitError(
          'x',
          ' ! [rejected]        HEAD -> gh-pages (fetch first)',
          1,
        ),
      ),
    ).toBe(true);
    expect(
      isRaceRejection(
        new GitError('x', 'remote: Permission to o/r.git denied', 128),
      ),
    ).toBe(false);
    expect(isRaceRejection(new Error('other'))).toBe(false);
  });
});
