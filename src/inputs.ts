import * as core from '@actions/core';
import { parseRepo } from './utils/github.js';

export interface BranchTarget {
  /** owner/name of the repo this branch lives in. */
  repoSlug: string;
  branch: string;
  /** Subpath inside the branch where content is written. Empty = root. */
  path: string;
  /** True iff this target is a repo other than the consuming workflow's repo. */
  isSibling: boolean;
  /** Authenticated HTTPS URL for git operations. */
  url: string;
}

export interface Inputs {
  data: BranchTarget;
  pages: BranchTarget;
  resultsDir: string;
  token: string;
  commitName: string;
  commitEmail: string;
  commitMessage: string;
  allureVersion: string;
  autoCreateSiblings: boolean;
  siblingVisibility: 'public' | 'private';
}

type Env = Record<string, string | undefined>;

function buildUrl(slug: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${slug}.git`;
}

function parseBool(raw: string, name: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`Invalid boolean for ${name}: ${JSON.stringify(raw)}`);
}

function parseVisibility(raw: string): 'public' | 'private' {
  const v = raw.trim().toLowerCase();
  if (v === 'public') return 'public';
  if (v === 'private') return 'private';
  throw new Error(
    `Invalid sibling-repo-visibility: ${JSON.stringify(raw)} (expected public|private)`,
  );
}

/** Read and validate all action inputs. Pure function over getInput + env
 *  so it's straightforward to unit-test by injecting both. */
export function readInputs(
  getInput: (name: string) => string = n => core.getInput(n),
  env: Env = process.env,
): Inputs {
  const currentRepo = env.GITHUB_REPOSITORY;
  if (!currentRepo) {
    throw new Error(
      'GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.',
    );
  }

  const token = getInput('token') || env.GITHUB_TOKEN || '';
  if (!token) {
    throw new Error(
      'No token provided. Set `token` input or ensure GITHUB_TOKEN is available.',
    );
  }

  const dataRepoSlug = getInput('data-repo') || currentRepo;
  const pagesRepoSlug = getInput('pages-repo') || currentRepo;

  // Validate slug formats early.
  parseRepo(dataRepoSlug);
  parseRepo(pagesRepoSlug);

  const data: BranchTarget = {
    repoSlug: dataRepoSlug,
    branch: getInput('data-branch') || 'allure-data',
    path: getInput('data-path').replace(/^\/+|\/+$/g, ''),
    isSibling: dataRepoSlug !== currentRepo,
    url: buildUrl(dataRepoSlug, token),
  };

  const pages: BranchTarget = {
    repoSlug: pagesRepoSlug,
    branch: getInput('pages-branch') || 'gh-pages',
    path: getInput('pages-path').replace(/^\/+|\/+$/g, ''),
    isSibling: pagesRepoSlug !== currentRepo,
    url: buildUrl(pagesRepoSlug, token),
  };

  return {
    data,
    pages,
    resultsDir: getInput('results-dir') || 'allure-results',
    token,
    commitName: getInput('commit-name') || 'github-actions[bot]',
    commitEmail:
      getInput('commit-email') ||
      '41898282+github-actions[bot]@users.noreply.github.com',
    commitMessage:
      getInput('commit-message') || 'standalone-stats: publish run',
    allureVersion: getInput('allure-version') || '2.30.0',
    autoCreateSiblings: parseBool(
      getInput('auto-create-sibling-repos') || 'true',
      'auto-create-sibling-repos',
    ),
    siblingVisibility: parseVisibility(
      getInput('sibling-repo-visibility') || 'public',
    ),
  };
}
