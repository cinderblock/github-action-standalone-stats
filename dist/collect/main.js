import {
  getInput,
  setOutput,
  setFailed,
  warning,
  info,
  emptyTotals,
  addTest,
  parseMatrix,
  identity,
  parseList,
  parseFormat,
  gather,
  readContext,
  DEFAULT_PREFIX,
  uploadArtifact
} from "../chunks/main-xvb5k137.js";

// src/collect/main.ts
async function run() {
  const ctx = readContext();
  const patterns = parseList(getInput("tests"));
  if (!patterns.length)
    throw new Error("Set `tests` to the result files (globs, one per line).");
  const id = identity(ctx.job, parseMatrix(getInput("matrix")), getInput("id").trim(), ctx.runnerOs);
  const format = parseFormat(getInput("test-format"));
  const upload = await gather({
    identity: id,
    testPatterns: patterns,
    ...format ? { testFormat: format } : {},
    flags: parseList(getInput("flags")),
    workspace: ctx.workspace,
    attempt: ctx.run.attempt
  });
  const missing = getInput("if-no-files-found").trim().toLowerCase() || "warn";
  if (!upload.sources.length) {
    const msg = `No test results matched: ${patterns.join(", ")}`;
    if (missing === "error")
      throw new Error(msg);
    if (missing === "warn")
      warning(msg);
  }
  const totals = emptyTotals();
  for (const t of upload.tests)
    addTest(totals, t);
  for (const s of upload.sources)
    info(`${s.format}: ${s.path} (${s.tests} tests)`);
  info(`${id.label}: ${totals.passed} passed, ${totals.failed + totals.errored} failing, ${totals.skipped} skipped`);
  const prefix = getInput("artifact-prefix").trim() || DEFAULT_PREFIX;
  const retention = Number(getInput("retention-days") || 7);
  const name = await uploadArtifact(upload, prefix, Number.isInteger(retention) && retention > 0 ? retention : 7);
  info(`Uploaded ${name}`);
  setOutput("key", upload.key);
  setOutput("artifact", name);
  setOutput("tests-total", String(totals.total));
  setOutput("tests-failed", String(totals.failed + totals.errored));
}
run().catch((err) => {
  setFailed(err instanceof Error ? err.message : String(err));
});
