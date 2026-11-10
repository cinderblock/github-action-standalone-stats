import { describe, expect, it } from 'bun:test';
import { textWidth, testsBadge } from '../src/badge.js';
import { readContext, shouldRecord } from '../src/context.js';
import { defaultPagesUrl } from '../src/github.js';
import { readPublishInputs } from '../src/publish/inputs.js';
import { checkPrivacy } from '../src/publish/privacy.js';

const inputs = (vals: Record<string, string>) => (n: string) => vals[n] ?? '';

describe('readPublishInputs', () => {
  it('defaults to gh-pages:stats/ in the current repo', () => {
    const i = readPublishInputs(inputs({ token: 't' }), 'o/r');
    expect(i).toMatchObject({
      repo: 'o/r',
      foreign: false,
      branch: 'gh-pages',
      path: 'stats',
      record: 'auto',
    });
    expect(i.historyWindow).toBe(30);
  });
  it('namespaces the path in a shared stats repo', () => {
    const i = readPublishInputs(inputs({ token: 't', repo: 'o/stats' }), 'o/r');
    expect(i.foreign).toBe(true);
    expect(i.path).toBe('o/r/stats');
  });
  it('rejects unsafe paths, branches and values', () => {
    expect(() =>
      readPublishInputs(inputs({ token: 't', path: '../x' }), 'o/r'),
    ).toThrow(/path/);
    expect(() =>
      readPublishInputs(inputs({ token: 't', path: '.git/hooks' }), 'o/r'),
    ).toThrow(/path/);
    expect(() =>
      readPublishInputs(inputs({ token: 't', branch: '-x' }), 'o/r'),
    ).toThrow(/branch/);
    expect(() =>
      readPublishInputs(inputs({ token: 't', record: 'sometimes' }), 'o/r'),
    ).toThrow(/record/);
    expect(() =>
      readPublishInputs(inputs({ token: 't', 'history-window': '0' }), 'o/r'),
    ).toThrow(/history-window/);
    expect(() => readPublishInputs(inputs({}), 'o/r')).toThrow(/token/);
  });
});

describe('shouldRecord', () => {
  const base = readContext({
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push',
  });
  const on = (event: string, branch: string) => ({
    ...base,
    defaultBranch: 'main',
    commit: { ...base.commit, event, branch },
  });
  it('records default-branch pushes, schedules and manual runs only', () => {
    expect(shouldRecord('auto', on('push', 'main'))).toBe(true);
    expect(shouldRecord('auto', on('schedule', 'main'))).toBe(true);
    expect(shouldRecord('auto', on('push', 'feature'))).toBe(false);
    expect(shouldRecord('auto', on('pull_request', 'main'))).toBe(false);
    expect(shouldRecord('always', on('pull_request', 'x'))).toBe(true);
    expect(shouldRecord('never', on('push', 'main'))).toBe(false);
  });
});

describe('checkPrivacy', () => {
  const pages = {
    state: 'enabled' as const,
    public: true,
    buildType: 'legacy',
    source: { branch: 'gh-pages', path: '/' },
  };
  it('allows public repos and private repos without public Pages', () => {
    expect(
      checkPrivacy({
        targetPrivate: false,
        pages,
        branch: 'gh-pages',
        allowPublic: false,
      }).ok,
    ).toBe(true);
    expect(
      checkPrivacy({
        targetPrivate: true,
        pages: { state: 'none' },
        branch: 'gh-pages',
        allowPublic: false,
      }).ok,
    ).toBe(true);
    expect(
      checkPrivacy({
        targetPrivate: true,
        pages: { ...pages, public: false },
        branch: 'gh-pages',
        allowPublic: false,
      }).ok,
    ).toBe(true);
    expect(
      checkPrivacy({
        targetPrivate: true,
        pages,
        branch: 'stats-data',
        allowPublic: false,
      }).ok,
    ).toBe(true);
  });
  it('refuses a private repo whose public Pages serves the stats branch, unless opted in', () => {
    expect(
      checkPrivacy({
        targetPrivate: true,
        pages,
        branch: 'gh-pages',
        allowPublic: false,
      }).ok,
    ).toBe(false);
    expect(
      checkPrivacy({
        targetPrivate: true,
        pages,
        branch: 'gh-pages',
        allowPublic: true,
      }).ok,
    ).toBe(true);
  });
  it('refuses when Pages settings are unreadable', () => {
    const d = checkPrivacy({
      targetPrivate: true,
      pages: { state: 'unknown', status: 403 },
      branch: 'gh-pages',
      allowPublic: false,
    });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toContain('pages: read');
  });
});

describe('badges and URLs', () => {
  it('renders test badges', () => {
    expect(
      testsBadge({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }),
    ).toContain('none');
    expect(
      testsBadge({ total: 3, passed: 2, failed: 1, errored: 0, skipped: 0 }),
    ).toContain('1 failing, 2 passing');
    expect(
      testsBadge({ total: 3, passed: 2, failed: 0, errored: 0, skipped: 1 }),
    ).toContain('2 passing, 1 skipped');
    expect(
      testsBadge({ total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }),
    ).toContain('#2e7d32');
    const svg = testsBadge(
      { total: 99, passed: 99, failed: 0, errored: 0, skipped: 0 },
      { total: 286 },
    );
    expect(svg).toContain('>99 passing<');
    expect(svg).toContain('aria-label="tests: 99 passing (286 results across jobs)"');
  });
  it('measures wide text wider', () => {
    expect(textWidth('mmm')).toBeGreaterThan(textWidth('iii'));
  });
  it('builds Pages URLs, including user/org sites', () => {
    expect(defaultPagesUrl({ owner: 'Cinderblock', name: 'x' }, 'stats')).toBe(
      'https://Cinderblock.github.io/x/stats/',
    );
    expect(defaultPagesUrl({ owner: 'o', name: 'o.github.io' }, '')).toBe(
      'https://o.github.io/',
    );
  });
});
