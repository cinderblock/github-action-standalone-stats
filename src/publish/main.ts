import * as core from '@actions/core';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gather, identity, parseMatrix } from '../collect/gather.js';
import { readContext, shouldRecord, type Context } from '../context.js';
import {
  checkout,
  publishBranch,
  remoteHasBranch,
  type Remote,
} from '../git.js';
import {
  compareDiff,
  createRepo,
  defaultPagesUrl,
  enablePages,
  getPages,
  getRepo,
  parseRepo,
  PermissionError,
} from '../github.js';
import { postStatuses, uploadReport, upsertComment } from '../post.js';
import { buildReport, thresholdLine } from '../report.js';
import { evaluate, failedRules, type RuleResult } from '../thresholds.js';
import type { DetailFile, RunRecord, Upload } from '../model.js';
import type { Diff } from '../coverage/patch.js';
import { pct } from '../coverage/model.js';
import { buildCoverage, parseCarryforward } from './coverage.js';
import { dedupe, downloadUploads } from '../upload.js';
import { GENERATOR } from '../version.js';
import { readPublishInputs, type PublishInputs } from './inputs.js';
import { buildRecord, compare } from './merge.js';
import { checkPrivacy } from './privacy.js';
import { applyRun, readBaseline, readDetail } from './store.js';
import { renderSummary } from './summary.js';

interface Baseline {
  record: RunRecord;
  detail?: DetailFile;
}

async function loadBaseline(
  root: string,
  repo: string,
  branch: string,
  excludeRunId: number,
): Promise<Baseline | undefined> {
  const record = await readBaseline(root, repo, branch, excludeRunId);
  if (!record) return undefined;
  const detail = await readDetail(root, record);
  return detail ? { record, detail } : { record };
}

const viewerDir = () => fileURLToPath(new URL('../viewer/', import.meta.url));

async function collectUploads(
  inputs: PublishInputs,
  ctx: Context,
): Promise<Upload[]> {
  const uploads: Upload[] = [];
  if (inputs.tests.length || inputs.coverage.length) {
    const id = identity(
      ctx.job,
      parseMatrix(inputs.matrix),
      inputs.id,
      ctx.runnerOs,
    );
    const local = await gather({
      identity: id,
      testPatterns: inputs.tests,
      ...(inputs.testFormat ? { testFormat: inputs.testFormat } : {}),
      coveragePatterns: inputs.coverage,
      ...(inputs.coverageFormat
        ? { coverageFormat: inputs.coverageFormat }
        : {}),
      warn: m => core.warning(m),
      flags: inputs.flags,
      workspace: ctx.workspace,
      attempt: ctx.run.attempt,
    });
    if (inputs.tests.length && !local.sources.length)
      core.warning(`No test results matched: ${inputs.tests.join(', ')}`);
    if (inputs.coverage.length && !local.coverage)
      core.warning(
        `No coverage reports matched: ${inputs.coverage.join(', ')}`,
      );
    uploads.push(local);
  }
  if (inputs.downloadArtifacts) {
    if (!process.env.ACTIONS_RUNTIME_TOKEN) {
      core.info(
        'No Actions runtime token, so collect artifacts were not downloaded.',
      );
    } else {
      const downloaded = await downloadUploads(inputs.artifactPrefix);
      core.info(
        `Downloaded ${downloaded.length} collect upload${downloaded.length === 1 ? '' : 's'}`,
      );
      uploads.push(...downloaded);
    }
  }
  return dedupe(uploads);
}

/** Read the baseline from the branch without writing anything. Works with a
 *  read-only token (fork PRs) as long as the repo is readable. */
async function readOnlyBaseline(
  remote: Remote,
  inputs: PublishInputs,
  ctx: Context,
  branch: string,
) {
  try {
    if (!(await remoteHasBranch(remote, inputs.branch))) return undefined;
    const { dir } = await checkout(remote, inputs.branch);
    try {
      return await loadBaseline(
        join(dir, inputs.path),
        inputs.repo,
        branch,
        ctx.run.id,
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    // A missing branch returned above; anything here is a real failure
    // (auth, network), so make it visible instead of a quiet "no baseline".
    core.warning(
      `Could not read the baseline, so nothing is compared: ${(err as Error).message}`,
    );
    return undefined;
  }
}

async function run(): Promise<void> {
  const ctx = readContext();
  const inputs = readPublishInputs(
    n => core.getInput(n),
    ctx.repo,
    process.env.GITHUB_TOKEN,
  );
  core.setSecret(inputs.token);
  const target = parseRepo(inputs.repo);
  const remote: Remote = {
    url: `${ctx.serverUrl}/${inputs.repo}.git`,
    token: inputs.token,
  };
  const api = { token: inputs.token };

  const uploads = await collectUploads(inputs, ctx);
  if (!uploads.length)
    core.warning(
      'No results: nothing matched `tests` or `coverage`, and no collect artifacts were found in this run.',
    );

  // Patch coverage: the lines this PR (or push) changed.
  let diff: { diff: Diff; base: string } | undefined;
  if (inputs.patchCoverage && ctx.patchBase && uploads.some(u => u.coverage)) {
    try {
      const d = await compareDiff(
        parseRepo(ctx.repo),
        ctx.patchBase,
        ctx.commit.sha,
        api,
      );
      if (d) diff = { diff: d, base: ctx.patchBase };
    } catch (err) {
      core.warning(`Patch coverage skipped: ${(err as Error).message}`);
    }
  }

  // The record depends on the baseline (carried-forward coverage), so it's
  // built after reading it, and rebuilt if a push race means a new clone.
  const carryforward = parseCarryforward(inputs.carryforward);
  const build = (base?: Baseline) => {
    const cov = buildCoverage(uploads, {
      key: `${ctx.run.id}-${ctx.run.attempt}`,
      sha: ctx.commit.sha,
      components: inputs.components,
      carryforward,
      ...(base?.detail ? { baselineDetail: base.detail } : {}),
      ...(diff ? { diff } : {}),
    });
    return {
      ...buildRecord(uploads, {
        run: ctx.run,
        commit: ctx.commit,
        ...(cov ? { coverage: cov } : {}),
      }),
      cov,
    };
  };
  let built = build();

  // Which history do we compare against: the PR's target, else the default.
  const baseBranch = ctx.baseBranch ?? ctx.defaultBranch;
  let recorded = false;
  let note: string | undefined;
  let baseline: Baseline | undefined;
  let siteUrl: string | undefined;

  let wantRecord = shouldRecord(inputs.record, ctx) && uploads.length > 0;
  if (wantRecord && ctx.fromFork) {
    wantRecord = false;
    note =
      'Pull requests from forks have a read-only token, so this run was compared but not recorded.';
  }

  if (wantRecord) {
    let info = await getRepo(target, api);
    if (!info && inputs.foreign && inputs.createRepo) {
      core.info(`Creating stats repo ${inputs.repo}`);
      await createRepo(target, { ...api, visibility: inputs.repoVisibility });
      info = await getRepo(target, api);
    }
    if (!info)
      throw new Error(
        `Stats repo ${inputs.repo} doesn't exist or isn't readable with this token.`,
      );
    const pages = await getPages(target, api);
    const privacy = checkPrivacy({
      targetPrivate: info.private,
      pages,
      branch: inputs.branch,
      allowPublic: inputs.allowPublicPagesForPrivateRepo,
    });
    if (!privacy.ok) {
      wantRecord = false;
      note = privacy.reason;
      core.warning(privacy.reason);
    } else if (privacy.warning) core.warning(privacy.warning);
    if (pages.state === 'enabled' && pages.url)
      siteUrl = `${pages.url.replace(/\/+$/, '')}/${inputs.path ? `${inputs.path}/` : ''}`;
    if (
      wantRecord &&
      pages.state === 'none' &&
      inputs.foreign &&
      inputs.createRepo
    )
      await enablePages(target, inputs.branch, api).catch(() => {});
  }

  siteUrl ??= defaultPagesUrl(target, inputs.path);

  if (wantRecord) {
    const message =
      inputs.commitMessage ||
      `stats: ${ctx.repo}@${ctx.commit.sha.slice(0, 7)} (run ${ctx.run.id}/${ctx.run.attempt})`;
    const result = await publishBranch({
      remote,
      branch: inputs.branch,
      message,
      author: inputs.author,
      attempts: inputs.pushAttempts,
      apply: async (dir, fresh) => {
        const root = inputs.path ? join(dir, inputs.path) : dir;
        await mkdir(root, { recursive: true });
        // Keep Jekyll out of a branch we created; it would skip nothing we
        // need and slows every Pages build.
        if (fresh) await writeFile(join(dir, '.nojekyll'), '');
        baseline = baseBranch
          ? await loadBaseline(root, inputs.repo, baseBranch, ctx.run.id)
          : undefined;
        built = build(baseline);
        await applyRun(root, built.record, built.tests, {
          repo: ctx.repo,
          window: inputs.historyWindow,
          detailWindow: inputs.detailWindow,
          ...(built.cov ? { detail: built.cov.detail } : {}),
          ...(inputs.viewer && existsSync(viewerDir())
            ? { viewerDir: viewerDir() }
            : {}),
          generator: GENERATOR,
        });
      },
    });
    try {
      recorded = result.committed;
      core.info(
        result.committed
          ? `Published to ${inputs.repo}:${inputs.branch}/${inputs.path} (attempt ${result.attempts})`
          : 'Nothing changed on the stats branch.',
      );
      const siteDir = join(
        process.env.RUNNER_TEMP || result.dir,
        'standalone-stats-site',
      );
      await rm(siteDir, { recursive: true, force: true });
      await cp(
        inputs.path ? join(result.dir, inputs.path) : result.dir,
        siteDir,
        {
          recursive: true,
          filter: src => !src.split(/[\\/]/).includes('.git'),
        },
      );
      core.setOutput('site-dir', siteDir);
    } finally {
      await rm(result.dir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (baseBranch) {
    baseline = await readOnlyBaseline(remote, inputs, ctx, baseBranch);
    built = build(baseline);
  }

  const { record, tests } = built;
  if (record.coverage?.carriedForward.length)
    core.info(
      `Carried forward from the baseline: ${record.coverage.carriedForward.join(', ')}`,
    );
  const cmp = baseline ? compare(record, tests, baseline.record) : undefined;
  publishOutputs(record, cmp?.newFailures.length ?? 0, siteUrl, recorded);

  const badgeUrl = `${siteUrl}badges/tests.svg`;
  const summaryLinks = {
    siteUrl,
    badgeUrl,
    coverageBadgeUrl: `${siteUrl}badges/coverage.svg`,
    recorded,
    ...(note ? { note } : {}),
  };
  const baseCov = cmp?.coverage?.baseRun.coverage;
  const results = evaluate(inputs.thresholds, record.coverage, baseCov);
  const thr = thresholdLine(results);
  await core.summary
    .addRaw(renderSummary(record, cmp, summaryLinks))
    .addRaw(
      thr
        ? `
${thr}
`
        : '',
    )
    .write();
  core.setOutput(
    'thresholds-passed',
    results.length ? String(!failedRules(results).length) : '',
  );
  for (const r of results)
    core.info(
      `Threshold ${r.label}: ${r.ok === false ? 'FAILED' : r.ok ? 'ok' : 'skipped'}, ${r.text}`,
    );

  await deliver({
    inputs,
    ctx,
    record,
    cmp,
    results,
    siteUrl,
    recorded,
    ...(note ? { note } : {}),
  });

  const bad = record.tests.totals.failed + record.tests.totals.errored;
  if (inputs.failOnTestFailure && bad)
    core.setFailed(`${bad} test result${bad === 1 ? '' : 's'} failed`);
  const failed = failedRules(results);
  if (inputs.failOnThreshold && failed.length)
    core.setFailed(
      `Coverage thresholds not met: ${failed.map(r => `${r.label} ${r.text}`).join('; ')}`,
    );
}

const PERMISSION_HINT =
  'Give the job `permissions: { pull-requests: write, statuses: write }`, or use the `comment` companion action (see the README).';

/**
 * The PR comment and commit statuses: posted directly when this token can,
 * else handed to the `comment` companion as an artifact. Never fails the
 * step; a missing permission is a warning.
 */
async function deliver(a: {
  inputs: PublishInputs;
  ctx: Context;
  record: RunRecord;
  cmp: ReturnType<typeof compare> | undefined;
  results: RuleResult[];
  siteUrl: string;
  recorded: boolean;
  note?: string;
}) {
  const { inputs, ctx, record } = a;
  const pr = ctx.commit.pr;
  const wants = {
    comment: inputs.comment !== 'never' && !!pr,
    statuses: inputs.thresholdStatus && inputs.thresholds.length > 0,
  };
  if (!wants.comment && !wants.statuses) return;
  const report = buildReport({
    record,
    cmp: a.cmp,
    workflow: ctx.run.workflow,
    runUrl: ctx.run.url,
    ...(pr ? { pr } : {}),
    siteUrl: a.siteUrl,
    recorded: a.recorded,
    ...(a.note ? { note: a.note } : {}),
    rules: inputs.thresholds,
    wants,
  });

  const left = { ...wants };
  const direct = inputs.comment !== 'artifact' && !ctx.fromFork;
  if (direct) {
    const repo = parseRepo(ctx.repo);
    const api = { token: inputs.token };
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (err) {
        if (err instanceof PermissionError) {
          core.warning(`${(err as Error).message}. ${PERMISSION_HINT}`);
          return false;
        }
        core.warning(`${what} failed: ${(err as Error).message}`);
        // A real failure isn't something the companion would do better.
        return true;
      }
    };
    if (wants.comment && pr)
      left.comment = !(await attempt('PR comment', async () => {
        const res = await upsertComment(
          repo,
          pr,
          report,
          inputs.thresholds,
          api,
        );
        if (res.action === 'skipped')
          core.info(`PR comment not updated: ${res.reason}`);
        else {
          core.info(`PR comment ${res.action}: ${res.url}`);
          core.setOutput('comment-url', res.url);
        }
      }));
    if (wants.statuses)
      left.statuses = !(await attempt('Commit statuses', async () => {
        const target = a.recorded
          ? `${a.siteUrl}#/runs/${record.key}`
          : ctx.run.url;
        const n = await postStatuses(
          repo,
          record.commit.sha,
          a.results,
          target,
          api,
        );
        core.info(`Posted ${n} commit status${n === 1 ? '' : 'es'}`);
      }));
  }
  if (left.comment || left.statuses) {
    report.wants = left;
    if (await uploadReport(report))
      core.info(
        `Report handed off for the comment companion (${[left.comment ? 'comment' : '', left.statuses ? 'statuses' : ''].filter(Boolean).join(' and ')}).`,
      );
  }
}

function publishOutputs(
  record: RunRecord,
  newFailures: number,
  siteUrl: string,
  recorded: boolean,
) {
  const t = record.tests.totals;
  const badgeUrl = `${siteUrl}badges/tests.svg`;
  core.setOutput('site-url', siteUrl);
  core.setOutput('badge-url', badgeUrl);
  core.setOutput('badge-markdown', `[![tests](${badgeUrl})](${siteUrl})`);
  core.setOutput('recorded', String(recorded));
  core.setOutput('run-key', record.key);
  core.setOutput('tests-total', String(t.total));
  core.setOutput('tests-passed', String(t.passed));
  core.setOutput('tests-failed', String(t.failed + t.errored));
  core.setOutput('tests-skipped', String(t.skipped));
  core.setOutput('new-failures', String(newFailures));
  const cov = record.coverage;
  const fmt = (r?: { hit: number; total: number }) =>
    r ? (pct(r)?.toFixed(2) ?? '') : '';
  core.setOutput('coverage-lines', fmt(cov?.totals.lines));
  core.setOutput('coverage-branches', fmt(cov?.totals.branches));
  core.setOutput('coverage-patch', fmt(cov?.patch));
  const covBadge = `${siteUrl}badges/coverage.svg`;
  core.setOutput('coverage-badge-url', cov ? covBadge : '');
  core.setOutput(
    'coverage-badge-markdown',
    cov ? `[![coverage](${covBadge})](${siteUrl})` : '',
  );
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
