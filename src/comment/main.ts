/**
 * The `comment` companion: posts the PR comment and commit statuses for a
 * run whose own token couldn't (fork PRs, read-only tokens).
 *
 * Run it from a `workflow_run` workflow. It reads the triggering run from
 * the API (trusted: head sha, event), downloads that run's report artifact
 * (untrusted: rebuilt by `sanitizeReport`), and checks that the PR the
 * report names really has that run's head commit before commenting.
 */
import * as core from '@actions/core';
import {
  getPages,
  getPull,
  getRun,
  parseRepo,
  PermissionError,
} from '../github.js';
import { postStatuses, downloadReport, upsertComment } from '../post.js';
import { sanitizeReport, thresholdLine } from '../report.js';
import { evaluate, failedRules, parseThresholds } from '../thresholds.js';

async function run(): Promise<void> {
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug)
    throw new Error(
      'GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.',
    );
  const repo = parseRepo(slug);
  const token = core.getInput('token') || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('No token. Set the `token` input.');
  core.setSecret(token);
  const api = { token };
  const runId = Number(core.getInput('run-id').trim());
  if (!Number.isInteger(runId) || runId <= 0)
    throw new Error(
      'No run-id. Run this from a `workflow_run` workflow, or set `run-id`.',
    );

  const wr = await getRun(repo, runId, api);
  const own = String(runId) === process.env.GITHUB_RUN_ID;
  const text = await downloadReport(
    own
      ? undefined
      : {
          token,
          workflowRunId: runId,
          repositoryOwner: repo.owner,
          repositoryName: repo.name,
        },
  );
  if (!text) {
    core.info(`Run ${runId} has no report; nothing to do.`);
    return;
  }

  const pages = await getPages(repo, api).catch(() => undefined);
  const hosts =
    pages?.state === 'enabled' && pages.url
      ? [new URL(pages.url).hostname.toLowerCase()]
      : [];
  const report = sanitizeReport(text, hosts);
  // Identity comes from the API, never from the artifact.
  const server = (
    process.env.GITHUB_SERVER_URL || 'https://github.com'
  ).replace(/\/+$/, '');
  report.runId = wr.id;
  report.attempt = wr.run_attempt || 1;
  report.runUrl = `${server}/${slug}/actions/runs/${wr.id}`;
  report.run.sha = wr.head_sha;

  const override = core.getInput('thresholds');
  const rules = override.trim() ? parseThresholds(override) : report.rules;
  const results = evaluate(
    rules,
    report.run.coverage,
    report.comparison?.baseCoverage,
  );
  core.setOutput(
    'thresholds-passed',
    results.length ? String(!failedRules(results).length) : '',
  );
  const thr = thresholdLine(results);
  if (thr) core.info(thr);

  let failures = 0;
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      failures++;
      const hint =
        err instanceof PermissionError
          ? ' Give this job `permissions: { actions: read, pull-requests: write, statuses: write }`.'
          : '';
      core.error(`${what}: ${(err as Error).message}.${hint}`);
    }
  };

  if (report.wants.comment && report.pr) {
    const pr = report.pr;
    await guard(`Commenting on #${pr}`, async () => {
      const pull = await getPull(repo, pr, api);
      if (
        !wr.event.startsWith('pull_request') ||
        pull?.head.sha !== wr.head_sha
      ) {
        core.warning(
          `PR #${pr} doesn't have run ${runId}'s head commit ${wr.head_sha.slice(0, 7)}; not commenting.`,
        );
        return;
      }
      const res = await upsertComment(repo, pr, report, rules, api);
      if (res.action === 'skipped')
        core.info(`Comment not updated: ${res.reason}`);
      else {
        core.info(`PR comment ${res.action}: ${res.url}`);
        core.setOutput('comment-url', res.url);
      }
    });
  }
  if (report.wants.statuses && rules.length) {
    await guard('Setting commit statuses', async () => {
      const target =
        report.recorded && report.siteUrl
          ? `${report.siteUrl}#/runs/${encodeURIComponent(report.run.key)}`
          : report.runUrl;
      const n = await postStatuses(repo, wr.head_sha, results, target, api);
      core.info(
        `Posted ${n} commit status${n === 1 ? '' : 'es'} on ${wr.head_sha.slice(0, 7)}`,
      );
    });
  }
  if (failures)
    core.setFailed(
      `${failures} delivery step${failures === 1 ? '' : 's'} failed`,
    );
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
