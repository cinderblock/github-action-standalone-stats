import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TEST_FORMAT_LIST, type TestCase, type TestFormat } from '../model.js';
import { readAllure, isAllureResult } from './allure.js';
import { isCtrf, readCtrf } from './ctrf.js';
import { isJunit, readJunit } from './junit.js';

export const TEST_FORMATS = TEST_FORMAT_LIST;

export interface ReadResult {
  format: TestFormat;
  /** The file, or for Allure the results directory. */
  path: string;
  tests: TestCase[];
}

/** Largest single input we'll parse. Reports bigger than this are almost
 *  certainly a mistake (or hostile), and parsing would exhaust memory. */
const MAX_BYTES = 256 * 1024 * 1024;

async function readText(path: string): Promise<string> {
  const s = await stat(path);
  if (s.size > MAX_BYTES)
    throw new Error(
      `${path} is ${s.size} bytes; refusing to parse more than ${MAX_BYTES}`,
    );
  // Strip a UTF-8 BOM; .NET and PowerShell tools love writing one.
  return (await readFile(path, 'utf8')).replace(/^﻿/, '');
}

const isAllureFile = (f: string) => f.endsWith('-result.json');

async function readAllureDir(
  dir: string,
  files?: string[],
): Promise<ReadResult> {
  const names = files ?? (await readdir(dir)).filter(isAllureFile);
  const results: unknown[] = [];
  for (const n of names) {
    try {
      results.push(JSON.parse(await readText(join(dir, n))));
    } catch (err) {
      throw new Error(`${join(dir, n)}: ${(err as Error).message}`);
    }
  }
  return { format: 'allure', path: dir, tests: readAllure(results) };
}

/**
 * Read test results from a set of matched paths. Format is detected from
 * content unless `forced`. Allure result files are grouped per directory, so
 * matching `allure-results/` or `allure-results/*-result.json` is the same.
 */
export async function readTestPaths(
  paths: string[],
  workspace: string,
  forced?: TestFormat,
): Promise<ReadResult[]> {
  const out: ReadResult[] = [];
  const allureFiles = new Map<string, string[]>();

  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory()) {
      if (forced && forced !== 'allure')
        throw new Error(
          `${p} is a directory; only Allure results are read from directories`,
        );
      const names = (await readdir(p)).filter(isAllureFile);
      if (names.length) allureFiles.set(p, names);
      continue;
    }
    if (forced === 'allure' || (!forced && isAllureFile(p))) {
      const dir = dirname(p);
      const list = allureFiles.get(dir) ?? [];
      if (!list.includes(basename(p))) list.push(basename(p));
      allureFiles.set(dir, list);
      continue;
    }

    const body = await readText(p);
    const trimmed = body.trimStart();
    if (forced === 'junit' || (!forced && trimmed.startsWith('<'))) {
      if (!forced && !isJunit(trimmed))
        throw new Error(
          `${p}: XML, but the root isn't <testsuites>/<testsuite>`,
        );
      out.push({ format: 'junit', path: p, tests: readJunit(body, workspace) });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`${p}: not XML or JSON; can't detect the test format`);
    }
    if (forced === 'ctrf' || isCtrf(json)) {
      out.push({ format: 'ctrf', path: p, tests: readCtrf(json, workspace) });
      continue;
    }
    if (isAllureResult(json)) {
      const dir = dirname(p);
      allureFiles.set(dir, [...(allureFiles.get(dir) ?? []), basename(p)]);
      continue;
    }
    throw new Error(`${p}: JSON, but not CTRF or an Allure result`);
  }

  for (const [dir, files] of allureFiles)
    out.push(await readAllureDir(dir, files));
  return out;
}
