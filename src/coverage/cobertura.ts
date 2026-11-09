import { attr, children, parseXml, text, type XmlNode } from '../readers/xml.js';
import type { RawCoverage } from './lcov.js';
import { LIMITS, addLine, type FileCov } from './model.js';

export function isCobertura(xml: string): boolean {
  return /<coverage[\s>]/.test(xml.slice(0, 64 * 1024));
}

export function isJacoco(xml: string): boolean {
  return /<!DOCTYPE report|<report[\s>]/.test(xml.slice(0, 64 * 1024));
}

/** `50% (1/2)` → `10`: counts only, front-filled (see model.ts). */
export function conditionBits(cc: string | undefined): string | undefined {
  const m = cc ? /\((\d+)\s*\/\s*(\d+)\)/.exec(cc) : null;
  if (!m) return undefined;
  const total = Math.min(Number(m[2]), LIMITS.branchesPerLine);
  const hit = Math.min(Number(m[1]), total);
  if (!total) return undefined;
  return '1'.repeat(hit) + '0'.repeat(total - hit);
}

/**
 * Parse Cobertura XML: gcovr, OpenCppCoverage, coverage.py, istanbul's
 * `cobertura` reporter, and others. Only class-level `<lines>` are read;
 * gcovr and coverage.py repeat lines under `<methods>`, and counting both
 * would double the hits.
 */
export function readCobertura(xml: string): RawCoverage {
  const doc = parseXml(xml, [
    'source',
    'package',
    'class',
    'line',
  ]);
  const root = doc.coverage as XmlNode | undefined;
  if (!root) throw new Error('no <coverage> root element');
  // <source> holds only text, so it comes back as strings, not nodes.
  const rawSources = (children(root, 'sources')[0] as XmlNode | undefined)
    ?.source;
  const bases = (Array.isArray(rawSources) ? rawSources : [rawSources])
    .map(s => text(s)?.trim() ?? '')
    .filter(Boolean);
  const files = new Map<string, FileCov>();
  let lines = 0;
  for (const pkg of children(children(root, 'packages')[0], 'package'))
    for (const cls of children(children(pkg, 'classes')[0], 'class')) {
      const name = attr(cls, 'filename')?.trim();
      if (!name) continue;
      let file = files.get(name);
      if (!file) {
        if (files.size >= LIMITS.files)
          throw new Error(`more than ${LIMITS.files} files in a Cobertura report`);
        file = new Map();
        files.set(name, file);
      }
      for (const l of children(children(cls, 'lines')[0], 'line')) {
        const n = Number(attr(l, 'number'));
        if (!Number.isInteger(n) || n < 1) continue;
        if (++lines > LIMITS.lines)
          throw new Error(`more than ${LIMITS.lines} lines in a Cobertura report`);
        const h = Number(attr(l, 'hits'));
        const br =
          attr(l, 'branch') === 'true'
            ? conditionBits(attr(l, 'condition-coverage'))
            : undefined;
        addLine(file, n, {
          hits: Number.isFinite(h) && h > 0 ? h : 0,
          ...(br ? { br } : {}),
        });
      }
    }
  return { files, bases };
}
