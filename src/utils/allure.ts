import * as core from '@actions/core';
import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from './spawn.js';
import { copyDir } from './copyDir.js';

interface GenerateOptions {
  resultsDir: string;
  reportDir: string;
  allureVersion: string;
  debug?: typeof core.debug;
}

/** Run `allure generate` against `resultsDir`, writing the rendered report
 *  into `reportDir`. Uses `bunx` to fetch the pinned allure-commandline
 *  package on demand — no separate install step required. */
export async function generate({
  resultsDir,
  reportDir,
  allureVersion,
  debug = core.debug,
}: GenerateOptions): Promise<void> {
  debug(
    `Generating allure report: ${resultsDir} → ${reportDir} (v${allureVersion})`,
  );
  // Use `npx -y` for portability — bunx isn't available on ubuntu-latest by
  // default, but every GitHub-hosted runner has npx.
  await spawn(
    'npx',
    '-y',
    `allure-commandline@${allureVersion}`,
    'generate',
    resultsDir,
    '--clean',
    '-o',
    reportDir,
  );
}

/** Copy `<reportDir>/history/` into `<resultsDir>/history/` so the next run
 *  can extend the trend graphs. No-op if the report has no history yet. */
export async function preserveHistory(
  reportDir: string,
  resultsDir: string,
): Promise<void> {
  const src = join(reportDir, 'history');
  const dst = join(resultsDir, 'history');
  if (!existsSync(src)) return;
  await rm(dst, { recursive: true, force: true });
  await copyDir(src, dst);
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
}

/** Read summary statistics from a generated allure report's
 *  `widgets/summary.json`. Returns zeros if the file is missing. */
export async function readSummary(reportDir: string): Promise<Summary> {
  const path = join(reportDir, 'widgets', 'summary.json');
  const empty: Summary = {
    total: 0,
    passed: 0,
    failed: 0,
    broken: 0,
    skipped: 0,
    unknown: 0,
  };
  if (!existsSync(path)) return empty;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      statistic?: Partial<Summary>;
    };
    return { ...empty, ...(parsed.statistic ?? {}) };
  } catch (err) {
    core.warning(
      `Failed to parse allure summary at ${path}: ${(err as Error).message}`,
    );
    return empty;
  }
}

/** Render a flat shields.io-style SVG badge summarizing pass/fail counts.
 *  Kept self-contained so we don't pull in another runtime dependency. */
export function renderBadgeSvg(summary: Summary): string {
  const status =
    summary.failed > 0 || summary.broken > 0
      ? `${summary.failed + summary.broken} failing`
      : summary.total > 0
        ? `${summary.passed} passing`
        : 'no tests';
  const color =
    summary.failed > 0 || summary.broken > 0
      ? '#e05d44'
      : summary.total > 0
        ? '#4c1'
        : '#9f9f9f';

  const labelText = 'allure';
  // Rough text widths at 11px DejaVu Sans (matches shields.io output).
  const labelW = labelText.length * 6 + 10;
  const statusW = status.length * 6 + 10;
  const totalW = labelW + statusW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${labelText}: ${status}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${statusW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text x="${(labelW / 2) * 10}" y="150" transform="scale(.1)" fill="#000" fill-opacity=".3">${labelText}</text>
    <text x="${(labelW / 2) * 10}" y="140" transform="scale(.1)">${labelText}</text>
    <text x="${(labelW + statusW / 2) * 10}" y="150" transform="scale(.1)" fill="#000" fill-opacity=".3">${status}</text>
    <text x="${(labelW + statusW / 2) * 10}" y="140" transform="scale(.1)">${status}</text>
  </g>
</svg>`;
}

/** Write `badge.svg` into the given directory based on the report's summary. */
export async function writeBadge(
  reportDir: string,
  outDir: string,
): Promise<void> {
  const summary = await readSummary(reportDir);
  const svg = renderBadgeSvg(summary);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'badge.svg'), svg, 'utf8');
}

/** True if the given directory contains at least one allure result file
 *  (raw -result.json/-container.json files allure expects). */
export async function hasResults(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const entries = await readdir(dir);
    return entries.some(
      e => e.endsWith('-result.json') || e.endsWith('-container.json'),
    );
  } catch {
    return false;
  }
}
