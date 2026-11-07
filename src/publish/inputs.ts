import { parseFormat, parseList } from '../collect/gather.js';
import { parseRecordMode, type RecordMode } from '../context.js';
import { parseRepo } from '../github.js';
import type { TestFormat } from '../model.js';
import { DEFAULT_PREFIX } from '../upload.js';

export interface PublishInputs {
  /** Repo holding the stats branch, `owner/name`. */
  repo: string;
  foreign: boolean;
  branch: string;
  /** Directory inside the branch. No leading/trailing slash; '' = root. */
  path: string;
  token: string;
  record: RecordMode;
  tests: string[];
  testFormat?: TestFormat;
  flags: string[];
  id: string;
  matrix: string;
  downloadArtifacts: boolean;
  artifactPrefix: string;
  historyWindow: number;
  viewer: boolean;
  allowPublicPagesForPrivateRepo: boolean;
  createRepo: boolean;
  repoVisibility: 'public' | 'private';
  failOnTestFailure: boolean;
  pushAttempts: number;
  author: { name: string; email: string };
  commitMessage: string;
}

export function parseBool(raw: string, name: string, dflt: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return dflt;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean for ${name}: ${JSON.stringify(raw)}`);
}

function parseIntInput(
  raw: string,
  name: string,
  dflt: number,
  min: number,
  max: number,
): number {
  const v = raw.trim();
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(
      `Invalid ${name}: ${JSON.stringify(raw)} (expected an integer ${min}–${max})`,
    );
  return n;
}

/** Branch names git and GitHub accept, without the corner cases. */
function checkBranch(b: string): string {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(b) ||
    b.startsWith('-') ||
    b.includes('..') ||
    b.endsWith('/') ||
    b.endsWith('.lock')
  )
    throw new Error(`Invalid branch name: ${JSON.stringify(b)}`);
  return b;
}

export function cleanPath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (s.split('/').some(seg => seg === '..' || seg === '.git'))
    throw new Error(`Invalid path: ${JSON.stringify(p)}`);
  return s;
}

export function readPublishInputs(
  getInput: (name: string) => string,
  currentRepo: string,
  envToken?: string,
): PublishInputs {
  const repo = getInput('repo').trim() || currentRepo;
  parseRepo(repo);
  const foreign = repo.toLowerCase() !== currentRepo.toLowerCase();
  const token = getInput('token') || envToken || '';
  if (!token)
    throw new Error(
      'No token. Set the `token` input (it defaults to github.token).',
    );

  const rawPath = getInput('path');
  // Several repos can share one stats repo; namespace them by default.
  const path = cleanPath(
    rawPath.trim() ? rawPath : foreign ? `${currentRepo}/stats` : 'stats',
  );

  const visibility = (getInput('repo-visibility').trim().toLowerCase() ||
    'public') as 'public' | 'private';
  if (visibility !== 'public' && visibility !== 'private')
    throw new Error(
      `Invalid repo-visibility: ${JSON.stringify(visibility)} (expected public or private)`,
    );

  const inputs: PublishInputs = {
    repo,
    foreign,
    branch: checkBranch(getInput('branch').trim() || 'gh-pages'),
    path,
    token,
    record: parseRecordMode(getInput('record')),
    tests: parseList(getInput('tests')).filter(Boolean),
    flags: parseList(getInput('flags')),
    id: getInput('id').trim(),
    matrix: getInput('matrix'),
    downloadArtifacts: parseBool(
      getInput('download-artifacts'),
      'download-artifacts',
      true,
    ),
    artifactPrefix: getInput('artifact-prefix').trim() || DEFAULT_PREFIX,
    historyWindow: parseIntInput(
      getInput('history-window'),
      'history-window',
      30,
      1,
      1000,
    ),
    viewer: parseBool(getInput('viewer'), 'viewer', true),
    allowPublicPagesForPrivateRepo: parseBool(
      getInput('allow-public-pages-for-private-repo'),
      'allow-public-pages-for-private-repo',
      false,
    ),
    createRepo: parseBool(getInput('create-repo'), 'create-repo', false),
    repoVisibility: visibility,
    failOnTestFailure: parseBool(
      getInput('fail-on-test-failure'),
      'fail-on-test-failure',
      false,
    ),
    pushAttempts: parseIntInput(
      getInput('push-attempts'),
      'push-attempts',
      6,
      1,
      20,
    ),
    author: {
      name: getInput('commit-name').trim() || 'github-actions[bot]',
      email:
        getInput('commit-email').trim() ||
        '41898282+github-actions[bot]@users.noreply.github.com',
    },
    commitMessage: getInput('commit-message').trim(),
  };
  const fmt = parseFormat(getInput('test-format'));
  if (fmt) inputs.testFormat = fmt;
  return inputs;
}
