import * as core from '@actions/core';
import { readContext } from '../context.js';
import { addTest, emptyTotals } from '../model.js';
import {
  decodeCoverage,
  formatPct,
  pct,
  totals as coverageTotals,
} from '../coverage/model.js';
import { parseCoverageFormat } from '../coverage/read.js';
import { DEFAULT_PREFIX, uploadArtifact } from '../upload.js';
import {
  gather,
  identity,
  parseFormat,
  parseList,
  parseMatrix,
} from './gather.js';

/**
 * `collect`: run in each matrix job after its tests. Reads the job's
 * results, normalizes paths against this job's workspace, and uploads one
 * small artifact for the fan-in `publish` job to merge.
 */
async function run(): Promise<void> {
  const ctx = readContext();
  const patterns = parseList(core.getInput('tests'));
  const covPatterns = parseList(core.getInput('coverage'));
  if (!patterns.length && !covPatterns.length)
    throw new Error(
      'Set `tests` (test result files) and/or `coverage` (coverage reports), as globs, one per line.',
    );
  const id = identity(
    ctx.job,
    parseMatrix(core.getInput('matrix')),
    core.getInput('id').trim(),
    ctx.runnerOs,
  );
  const format = parseFormat(core.getInput('test-format'));
  const covFormat = parseCoverageFormat(core.getInput('coverage-format'));
  const upload = await gather({
    identity: id,
    testPatterns: patterns,
    ...(format ? { testFormat: format } : {}),
    coveragePatterns: covPatterns,
    ...(covFormat ? { coverageFormat: covFormat } : {}),
    warn: m => core.warning(m),
    flags: parseList(core.getInput('flags')),
    workspace: ctx.workspace,
    attempt: ctx.run.attempt,
  });

  const missing = (core.getInput('if-no-files-found').trim().toLowerCase() ||
    'warn') as string;
  const unmatched = [
    patterns.length && !upload.sources.length
      ? `No test results matched: ${patterns.join(', ')}`
      : '',
    covPatterns.length && !upload.coverage?.sources.length
      ? `No coverage reports matched: ${covPatterns.join(', ')}`
      : '',
  ].filter(Boolean);
  for (const msg of unmatched) {
    if (missing === 'error') throw new Error(msg);
    if (missing === 'warn') core.warning(msg);
  }

  const totals = emptyTotals();
  for (const t of upload.tests) addTest(totals, t);
  for (const s of upload.sources)
    core.info(`${s.format}: ${s.path} (${s.tests} tests)`);
  if (patterns.length)
    core.info(
      `${id.label}: ${totals.passed} passed, ${totals.failed + totals.errored} failing, ${totals.skipped} skipped`,
    );
  let coverageLines = '';
  if (upload.coverage) {
    for (const s of upload.coverage.sources)
      core.info(
        `${s.format}: ${s.path} (${s.files} files${s.external ? `, ${s.external} outside the workspace skipped` : ''})`,
      );
    const t = coverageTotals(decodeCoverage(upload.coverage.files));
    coverageLines = pct(t.lines)?.toFixed(2) ?? '';
    core.info(
      `${id.label}: lines ${formatPct(t.lines)} (${t.lines.hit}/${t.lines.total}), branches ${formatPct(t.branches)} over ${t.files} files`,
    );
  }

  const prefix = core.getInput('artifact-prefix').trim() || DEFAULT_PREFIX;
  const retention = Number(core.getInput('retention-days') || 7);
  const name = await uploadArtifact(
    upload,
    prefix,
    Number.isInteger(retention) && retention > 0 ? retention : 7,
  );
  core.info(`Uploaded ${name}`);
  core.setOutput('key', upload.key);
  core.setOutput('artifact', name);
  core.setOutput('tests-total', String(totals.total));
  core.setOutput('tests-failed', String(totals.failed + totals.errored));
  core.setOutput('coverage-lines', coverageLines);
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
