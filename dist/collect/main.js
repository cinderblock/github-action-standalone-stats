import {
  getInput,
  setOutput,
  setFailed,
  warning,
  info,
  emptyTotals,
  addTest,
  totals,
  pct,
  formatPct,
  decodeCoverage,
  parseCoverageFormat,
  parseMatrix,
  identity,
  parseList,
  parseFormat,
  gather,
  readContext,
  DEFAULT_PREFIX,
  uploadArtifact
} from "../chunks/main-g8cm915c.js";

// src/collect/main.ts
async function run() {
  const ctx = readContext();
  const patterns = parseList(getInput("tests"));
  const covPatterns = parseList(getInput("coverage"));
  if (!patterns.length && !covPatterns.length)
    throw new Error("Set `tests` (test result files) and/or `coverage` (coverage reports), as globs, one per line.");
  const id = identity(ctx.job, parseMatrix(getInput("matrix")), getInput("id").trim(), ctx.runnerOs);
  const format = parseFormat(getInput("test-format"));
  const covFormat = parseCoverageFormat(getInput("coverage-format"));
  const upload = await gather({
    identity: id,
    testPatterns: patterns,
    ...format ? { testFormat: format } : {},
    coveragePatterns: covPatterns,
    ...covFormat ? { coverageFormat: covFormat } : {},
    warn: (m) => warning(m),
    flags: parseList(getInput("flags")),
    workspace: ctx.workspace,
    attempt: ctx.run.attempt
  });
  const missing = getInput("if-no-files-found").trim().toLowerCase() || "warn";
  const unmatched = [
    patterns.length && !upload.sources.length ? `No test results matched: ${patterns.join(", ")}` : "",
    covPatterns.length && !upload.coverage?.sources.length ? `No coverage reports matched: ${covPatterns.join(", ")}` : ""
  ].filter(Boolean);
  for (const msg of unmatched) {
    if (missing === "error")
      throw new Error(msg);
    if (missing === "warn")
      warning(msg);
  }
  const totals2 = emptyTotals();
  for (const t of upload.tests)
    addTest(totals2, t);
  for (const s of upload.sources)
    info(`${s.format}: ${s.path} (${s.tests} tests)`);
  if (patterns.length)
    info(`${id.label}: ${totals2.passed} passed, ${totals2.failed + totals2.errored} failing, ${totals2.skipped} skipped`);
  let coverageLines = "";
  if (upload.coverage) {
    for (const s of upload.coverage.sources)
      info(`${s.format}: ${s.path} (${s.files} files${s.external ? `, ${s.external} outside the workspace skipped` : ""})`);
    const t = totals(decodeCoverage(upload.coverage.files));
    coverageLines = pct(t.lines)?.toFixed(2) ?? "";
    info(`${id.label}: lines ${formatPct(t.lines)} (${t.lines.hit}/${t.lines.total}), branches ${formatPct(t.branches)} over ${t.files} files`);
  }
  const prefix = getInput("artifact-prefix").trim() || DEFAULT_PREFIX;
  const retention = Number(getInput("retention-days") || 7);
  const name = await uploadArtifact(upload, prefix, Number.isInteger(retention) && retention > 0 ? retention : 7);
  info(`Uploaded ${name}`);
  setOutput("key", upload.key);
  setOutput("artifact", name);
  setOutput("tests-total", String(totals2.total));
  setOutput("tests-failed", String(totals2.failed + totals2.errored));
  setOutput("coverage-lines", coverageLines);
}
run().catch((err) => {
  setFailed(err instanceof Error ? err.message : String(err));
});
