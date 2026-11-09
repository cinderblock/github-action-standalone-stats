import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { toPosix, workspaceRelative } from '../paths.js';
import { isCobertura, isJacoco, readCobertura } from './cobertura.js';
import { isLcov, readLcov, type RawCoverage } from './lcov.js';
import {
  COVERAGE_FORMAT_LIST,
  mergeCoverage,
  type Coverage,
  type CoverageFormat,
} from './model.js';

export interface CoverageSource {
  format: CoverageFormat;
  /** Workspace-relative path of the report. */
  path: string;
  /** Files kept from it. */
  files: number;
  /** Files dropped because they're outside the workspace. */
  external: number;
}

export interface CoverageRead {
  sources: CoverageSource[];
  coverage: Coverage;
  warnings: string[];
}

const MAX_BYTES = 512 * 1024 * 1024;

export function parseCoverageFormat(raw: string): CoverageFormat | undefined {
  const v = raw.trim().toLowerCase();
  if (!v || v === 'auto') return undefined;
  if ((COVERAGE_FORMAT_LIST as string[]).includes(v)) return v as CoverageFormat;
  throw new Error(
    `Unknown coverage format ${JSON.stringify(raw)} (expected auto, ${COVERAGE_FORMAT_LIST.join(', ')})`,
  );
}

export function detectCoverage(
  body: string,
  name: string,
  forced?: CoverageFormat,
): { format: CoverageFormat; raw: RawCoverage } {
  const trimmed = body.trimStart();
  if (forced === 'cobertura' || (!forced && trimmed.startsWith('<'))) {
    if (!forced && !isCobertura(trimmed)) {
      if (isJacoco(trimmed))
        throw new Error(
          `${name}: JaCoCo XML isn't supported; have JaCoCo write Cobertura or lcov, or convert it first`,
        );
      throw new Error(`${name}: XML, but not a Cobertura <coverage> report`);
    }
    return { format: 'cobertura', raw: readCobertura(body) };
  }
  if (forced === 'lcov' || isLcov(trimmed))
    return { format: 'lcov', raw: readLcov(body) };
  throw new Error(`${name}: not lcov or Cobertura; can't detect the coverage format`);
}

/**
 * Resolve a report's file names against this job's workspace. Absolute
 * names outside it are dropped. If nothing resolves inside the workspace but
 * the report used relative names, those are kept as written: the report was
 * probably made somewhere else (a container), relative to the repo root.
 */
export function resolveRaw(
  raw: RawCoverage,
  workspace: string,
  exists: (p: string) => boolean = existsSync,
): { coverage: Coverage; external: number; keptRelative: boolean } {
  const coverage: Coverage = new Map();
  let external = 0;
  for (const [name, file] of raw.files) {
    const rel = workspaceRelative(name, workspace, raw.bases, exists);
    if (rel === undefined || rel.startsWith('../')) {
      external++;
      continue;
    }
    mergeCoverage(coverage, new Map([[rel, file]]));
  }
  if (!coverage.size && raw.files.size) {
    const relativeNames = [...raw.files].filter(
      ([n]) => !/^([a-zA-Z]:|[\\/])/.test(n),
    );
    if (relativeNames.length) {
      for (const [name, file] of relativeNames)
        mergeCoverage(coverage, new Map([[toPosix(name), file]]));
      return {
        coverage,
        external: raw.files.size - relativeNames.length,
        keptRelative: true,
      };
    }
  }
  return { coverage, external, keptRelative: false };
}

export async function readCoveragePaths(
  paths: string[],
  workspace: string,
  forced?: CoverageFormat,
): Promise<CoverageRead> {
  const out: CoverageRead = { sources: [], coverage: new Map(), warnings: [] };
  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory()) continue;
    if (s.size > MAX_BYTES)
      throw new Error(`${p} is ${s.size} bytes; refusing to parse more than ${MAX_BYTES}`);
    const body = (await readFile(p, 'utf8')).replace(/^﻿/, '');
    const shown = toPosix(relative(workspace, p)) || p;
    const { format, raw } = detectCoverage(body, shown, forced);
    const r = resolveRaw(raw, workspace);
    if (r.keptRelative)
      out.warnings.push(
        `${shown}: no file resolved inside the workspace, so its relative names were kept as written`,
      );
    else if (raw.files.size && !r.coverage.size)
      out.warnings.push(
        `${shown}: every file is outside the workspace (${toPosix(workspace)}); nothing kept`,
      );
    mergeCoverage(out.coverage, r.coverage);
    out.sources.push({
      format,
      path: shown,
      files: r.coverage.size,
      external: r.external,
    });
  }
  return out;
}
