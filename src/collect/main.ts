import * as core from '@actions/core';
import { readContext } from '../context.js';
import { addTest, emptyTotals } from '../model.js';
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
  if (!patterns.length)
    throw new Error('Set `tests` to the result files (globs, one per line).');
  const id = identity(
    ctx.job,
    parseMatrix(core.getInput('matrix')),
    core.getInput('id').trim(),
    ctx.runnerOs,
  );
  const format = parseFormat(core.getInput('test-format'));
  const upload = await gather({
    identity: id,
    testPatterns: patterns,
    ...(format ? { testFormat: format } : {}),
    flags: parseList(core.getInput('flags')),
    workspace: ctx.workspace,
    attempt: ctx.run.attempt,
  });

  const missing = (core.getInput('if-no-files-found').trim().toLowerCase() ||
    'warn') as string;
  if (!upload.sources.length) {
    const msg = `No test results matched: ${patterns.join(', ')}`;
    if (missing === 'error') throw new Error(msg);
    if (missing === 'warn') core.warning(msg);
  }

  const totals = emptyTotals();
  for (const t of upload.tests) addTest(totals, t);
  for (const s of upload.sources)
    core.info(`${s.format}: ${s.path} (${s.tests} tests)`);
  core.info(
    `${id.label}: ${totals.passed} passed, ${totals.failed + totals.errored} failing, ${totals.skipped} skipped`,
  );

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
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
