import * as core from '@actions/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInputs, type BranchTarget, type Inputs } from './inputs.js';
import { cloneOrOrphan } from './utils/clone.js';
import { commitAndPush } from './utils/commitAndPush.js';
import { copyDir } from './utils/copyDir.js';
import {
  parseRepo,
  repoExists,
  createRepo,
  ensurePages,
  pagesUrl,
} from './utils/github.js';
import {
  generate,
  preserveHistory,
  writeBadge,
  hasResults,
  readSummary,
} from './utils/allure.js';

async function ensureRepo(target: BranchTarget, inputs: Inputs): Promise<void> {
  if (!target.isSibling) return;
  const ref = parseRepo(target.repoSlug);
  if (await repoExists(ref, { token: inputs.token })) return;
  if (!inputs.autoCreateSiblings) {
    throw new Error(
      `Sibling repo ${target.repoSlug} does not exist and auto-create-sibling-repos is false.`,
    );
  }
  core.info(`Creating sibling repo ${target.repoSlug}…`);
  await createRepo(ref, {
    token: inputs.token,
    visibility: inputs.siblingVisibility,
  });
}

async function publishData(inputs: Inputs, reportTmp: string): Promise<string> {
  const dataTmp = await mkdtemp(join(tmpdir(), 'sst-data-'));
  try {
    await ensureRepo(inputs.data, inputs);
    await cloneOrOrphan({
      repoUrl: inputs.data.url,
      dir: dataTmp,
      branch: inputs.data.branch,
    });

    const dataTarget = inputs.data.path
      ? join(dataTmp, inputs.data.path)
      : dataTmp;
    // Merge this run's fresh results into the cumulative data dir.
    await copyDir(inputs.resultsDir, dataTarget);
    // Save the report's history forward for the next run's trend graphs.
    await preserveHistory(reportTmp, dataTarget);

    await commitAndPush({
      dir: dataTmp,
      branch: inputs.data.branch,
      message: inputs.commitMessage,
      name: inputs.commitName,
      email: inputs.commitEmail,
    });
    return dataTmp;
  } finally {
    await rm(dataTmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function publishPages(
  inputs: Inputs,
  reportTmp: string,
): Promise<string> {
  const pagesTmp = await mkdtemp(join(tmpdir(), 'sst-pages-'));
  try {
    await ensureRepo(inputs.pages, inputs);

    if (inputs.pages.isSibling) {
      // Best-effort: enable Pages on the sibling repo on first publish.
      await ensurePages(
        parseRepo(inputs.pages.repoSlug),
        inputs.pages.branch,
        inputs.pages.path,
        { token: inputs.token },
      );
    }

    await cloneOrOrphan({
      repoUrl: inputs.pages.url,
      dir: pagesTmp,
      branch: inputs.pages.branch,
    });

    const pagesTarget = inputs.pages.path
      ? join(pagesTmp, inputs.pages.path)
      : pagesTmp;
    // Wholesale replace the published report. We do this rather than merge
    // because allure rewrites every file on each generate and stale files
    // would only cause confusion.
    await copyDir(reportTmp, pagesTarget);
    await writeBadge(reportTmp, pagesTarget);

    await commitAndPush({
      dir: pagesTmp,
      branch: inputs.pages.branch,
      message: inputs.commitMessage,
      name: inputs.commitName,
      email: inputs.commitEmail,
    });
    return pagesTmp;
  } finally {
    await rm(pagesTmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(): Promise<void> {
  const inputs = readInputs();

  if (!(await hasResults(inputs.resultsDir))) {
    throw new Error(
      `No allure result files (*-result.json / *-container.json) found in ${JSON.stringify(
        inputs.resultsDir,
      )}. Make sure your test step writes results there before this action runs.`,
    );
  }

  // Build a merged-results dir so `allure generate` sees both the historical
  // results (with history/) AND this run's fresh files. We pull history by
  // cloning the data branch into a scratch dir first.
  const mergedTmp = await mkdtemp(join(tmpdir(), 'sst-merge-'));
  const reportTmp = await mkdtemp(join(tmpdir(), 'sst-report-'));
  try {
    // Bring in last run's accumulated results (provides history/).
    try {
      const scratchData = await mkdtemp(join(tmpdir(), 'sst-scratch-data-'));
      try {
        await cloneOrOrphan({
          repoUrl: inputs.data.url,
          dir: scratchData,
          branch: inputs.data.branch,
        });
        const scratchSrc = inputs.data.path
          ? join(scratchData, inputs.data.path)
          : scratchData;
        await copyDir(scratchSrc, mergedTmp);
      } finally {
        await rm(scratchData, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      // Empty data branch (first run) — fine, just proceed with fresh results.
      core.debug(
        `No prior data branch contents (${(err as Error).message}); first-run case.`,
      );
    }

    // Layer this run's fresh results on top.
    await copyDir(inputs.resultsDir, mergedTmp);

    await generate({
      resultsDir: mergedTmp,
      reportDir: reportTmp,
      allureVersion: inputs.allureVersion,
    });

    // Publish data branch first (carries history forward for next run),
    // then pages branch (the user-visible artifact).
    await publishData(inputs, reportTmp);
    await publishPages(inputs, reportTmp);

    const pagesRef = parseRepo(inputs.pages.repoSlug);
    const url = pagesUrl(pagesRef, inputs.pages.path);
    const badgeSrc = `${url}badge.svg`;
    const badgeMarkdown = `[![Allure Report](${badgeSrc})](${url})`;
    core.setOutput('pages-url', url);
    core.setOutput('badge-markdown', badgeMarkdown);
    core.setOutput('data-branch-ref', `refs/heads/${inputs.data.branch}`);
    core.setOutput('pages-branch-ref', `refs/heads/${inputs.pages.branch}`);

    const summary = await readSummary(reportTmp);
    await core.summary
      .addHeading('Standalone Stats', 2)
      .addRaw(
        `<p><a href="${url}"><img src="${badgeSrc}" alt="Allure Report"/></a></p>`,
      )
      .addTable([
        [
          { data: 'Total', header: true },
          { data: 'Passed', header: true },
          { data: 'Failed', header: true },
          { data: 'Broken', header: true },
          { data: 'Skipped', header: true },
        ],
        [
          String(summary.total),
          String(summary.passed),
          String(summary.failed),
          String(summary.broken),
          String(summary.skipped),
        ],
      ])
      .addRaw(`<p>Report: <a href="${url}">${url}</a></p>`)
      .addRaw(`<pre>${badgeMarkdown}</pre>`)
      .write();
  } finally {
    await rm(mergedTmp, { recursive: true, force: true }).catch(() => {});
    await rm(reportTmp, { recursive: true, force: true }).catch(() => {});
  }
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
