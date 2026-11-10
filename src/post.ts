/** Delivering a report: the sticky PR comment, commit statuses, and the
 *  artifact hand-off to the `comment` companion. */
import * as core from '@actions/core';
import { DefaultArtifactClient, type FindOptions } from '@actions/artifact';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createComment,
  createStatus,
  listComments,
  updateComment,
  type ApiOptions,
  type RepoRef,
} from './github.js';
import {
  REPORT_ARTIFACT,
  REPORT_FILE,
  markerPrefix,
  markerRun,
  renderComment,
  type Report,
} from './report.js';
import { statusesFor, type RuleResult, type Rule } from './thresholds.js';

export type CommentResult =
  | { action: 'created' | 'updated'; url: string }
  | { action: 'skipped'; reason: string };

/**
 * Create or update this workflow's comment on a PR. One comment per
 * workflow, found by its marker; only comments by a bot are edited. A run
 * older than the one that last wrote the comment (a re-run of an old
 * commit) leaves it alone.
 */
export async function upsertComment(
  repo: RepoRef,
  pr: number,
  report: Report,
  rules: Rule[],
  opts: ApiOptions,
): Promise<CommentResult> {
  const body = renderComment(report, rules);
  const prefix = markerPrefix(report.workflow);
  const mine = (await listComments(repo, pr, opts)).filter(
    c => c.user?.type === 'Bot' && c.body?.includes(prefix),
  );
  const existing = mine[0];
  if (existing) {
    const last = markerRun(existing.body, report.workflow);
    if (last !== undefined && last > report.runId)
      return {
        action: 'skipped',
        reason: `the comment is from a newer run (${last})`,
      };
    const c = await updateComment(repo, existing.id, body, opts);
    return { action: 'updated', url: c.html_url };
  }
  const c = await createComment(repo, pr, body, opts);
  return { action: 'created', url: c.html_url };
}

/** One commit status per threshold group (`standalone-stats/coverage`,
 *  `standalone-stats/patch`). */
export async function postStatuses(
  repo: RepoRef,
  sha: string,
  results: RuleResult[],
  targetUrl: string | undefined,
  opts: ApiOptions,
): Promise<number> {
  const updates = statusesFor(results);
  for (const s of updates)
    await createStatus(
      repo,
      sha,
      { ...s, ...(targetUrl ? { target_url: targetUrl } : {}) },
      opts,
    );
  return updates.length;
}

/** Upload the report for the companion. Best effort: a warning on failure. */
export async function uploadReport(
  report: Report,
  retentionDays = 7,
): Promise<boolean> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    core.warning(
      'No Actions runtime token, so the report artifact was not uploaded.',
    );
    return false;
  }
  const dir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'standalone-stats-report-'),
  );
  try {
    const file = join(dir, REPORT_FILE);
    await writeFile(file, JSON.stringify(report));
    await new DefaultArtifactClient().uploadArtifact(
      REPORT_ARTIFACT,
      [file],
      dir,
      { retentionDays },
    );
    return true;
  } catch (err) {
    core.warning(
      `Could not upload the report artifact: ${(err as Error).message}`,
    );
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The report artifact's text from a run, or undefined if the run has none.
 * Another run needs `findBy` (a token with `actions: read`); the current run
 * uses the runtime token.
 */
export async function downloadReport(
  findBy: FindOptions['findBy'] | undefined,
): Promise<string | undefined> {
  const client = new DefaultArtifactClient();
  const opts = findBy ? { findBy } : {};
  const { artifacts } = await client.listArtifacts({ latest: true, ...opts });
  const a = artifacts.find(x => x.name === REPORT_ARTIFACT);
  if (!a) return undefined;
  const dir = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'standalone-stats-report-dl-'),
  );
  try {
    await client.downloadArtifact(a.id, { path: dir, ...opts });
    if (!(await readdir(dir)).includes(REPORT_FILE))
      throw new Error(`artifact ${REPORT_ARTIFACT} has no ${REPORT_FILE}`);
    return await readFile(join(dir, REPORT_FILE), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
