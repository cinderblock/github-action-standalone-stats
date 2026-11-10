import {
  setSecret,
  getInput,
  setOutput,
  setFailed,
  error,
  warning,
  info
} from "../chunks/main-thpahjqj.js";
import {
  parseRepo,
  getPages,
  PermissionError,
  getRun,
  getPull,
  parseThresholds,
  evaluate,
  failedRules,
  sanitizeReport,
  thresholdLine,
  upsertComment,
  postStatuses,
  downloadReport
} from "../chunks/main-01ywqfyn.js";

// src/comment/main.ts
async function run() {
  const slug = process.env.GITHUB_REPOSITORY;
  if (!slug)
    throw new Error("GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.");
  const repo = parseRepo(slug);
  const token = getInput("token") || process.env.GITHUB_TOKEN || "";
  if (!token)
    throw new Error("No token. Set the `token` input.");
  setSecret(token);
  const api = { token };
  const runId = Number(getInput("run-id").trim());
  if (!Number.isInteger(runId) || runId <= 0)
    throw new Error("No run-id. Run this from a `workflow_run` workflow, or set `run-id`.");
  const wr = await getRun(repo, runId, api);
  const own = String(runId) === process.env.GITHUB_RUN_ID;
  const text = await downloadReport(own ? undefined : {
    token,
    workflowRunId: runId,
    repositoryOwner: repo.owner,
    repositoryName: repo.name
  });
  if (!text) {
    info(`Run ${runId} has no report; nothing to do.`);
    return;
  }
  const pages = await getPages(repo, api).catch(() => {
    return;
  });
  const hosts = pages?.state === "enabled" && pages.url ? [new URL(pages.url).hostname.toLowerCase()] : [];
  const report = sanitizeReport(text, hosts);
  const server = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  report.runId = wr.id;
  report.attempt = wr.run_attempt || 1;
  report.runUrl = `${server}/${slug}/actions/runs/${wr.id}`;
  report.run.sha = wr.head_sha;
  const override = getInput("thresholds");
  const rules = override.trim() ? parseThresholds(override) : report.rules;
  const results = evaluate(rules, report.run.coverage, report.comparison?.baseCoverage);
  setOutput("thresholds-passed", results.length ? String(!failedRules(results).length) : "");
  const thr = thresholdLine(results);
  if (thr)
    info(thr);
  let failures = 0;
  const guard = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      failures++;
      const hint = err instanceof PermissionError ? " Give this job `permissions: { actions: read, pull-requests: write, statuses: write }`." : "";
      error(`${what}: ${err.message}.${hint}`);
    }
  };
  if (report.wants.comment && report.pr) {
    const pr = report.pr;
    await guard(`Commenting on #${pr}`, async () => {
      const pull = await getPull(repo, pr, api);
      if (!wr.event.startsWith("pull_request") || pull?.head.sha !== wr.head_sha) {
        warning(`PR #${pr} doesn't have run ${runId}'s head commit ${wr.head_sha.slice(0, 7)}; not commenting.`);
        return;
      }
      const res = await upsertComment(repo, pr, report, rules, api);
      if (res.action === "skipped")
        info(`Comment not updated: ${res.reason}`);
      else {
        info(`PR comment ${res.action}: ${res.url}`);
        setOutput("comment-url", res.url);
      }
    });
  }
  if (report.wants.statuses && rules.length) {
    await guard("Setting commit statuses", async () => {
      const target = report.recorded && report.siteUrl ? `${report.siteUrl}#/runs/${encodeURIComponent(report.run.key)}` : report.runUrl;
      const n = await postStatuses(repo, wr.head_sha, results, target, api);
      info(`Posted ${n} commit status${n === 1 ? "" : "es"} on ${wr.head_sha.slice(0, 7)}`);
    });
  }
  if (failures)
    setFailed(`${failures} delivery step${failures === 1 ? "" : "s"} failed`);
}
run().catch((err) => {
  setFailed(err instanceof Error ? err.message : String(err));
});
