import {
  debug,
  warning,
  SCHEMA,
  STATUS_SEVERITY,
  TEST_FORMAT_LIST,
  testId,
  truncate,
  XMLParser,
  COVERAGE_FORMAT_LIST,
  LIMITS,
  orBranches,
  addLine,
  mergeCoverage,
  encodeCoverage,
  decodeCoverage,
  DefaultArtifactClient
} from "./main-thpahjqj.js";

// src/coverage/read.ts
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

// src/paths.ts
function toPosix(p) {
  let s = p.replace(/\\/g, "/");
  if (/^file:\/\//i.test(s)) {
    s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    if (/^\/[a-zA-Z]:/.test(s))
      s = s.slice(1);
  }
  const drive = /^[a-zA-Z]:/.exec(s)?.[0];
  if (drive)
    s = s.slice(2);
  const absolute = s.startsWith("/");
  const out = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".")
      continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..")
      out.pop();
    else
      out.push(seg);
  }
  const body = out.join("/");
  return `${drive ? drive.toLowerCase() : ""}${absolute ? "/" : ""}${body}`;
}
function sameFs(a, b, caseInsensitive) {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function relativize(file, workspace, bases = []) {
  const ws = toPosix(workspace);
  const ci = /^[a-z]:/.test(ws) || /^[a-zA-Z]:/.test(file);
  const tryStrip = (abs, root) => {
    if (!root)
      return;
    const r = root.endsWith("/") ? root : `${root}/`;
    if (abs.length > r.length && sameFs(abs.slice(0, r.length), r, ci))
      return abs.slice(r.length);
    if (sameFs(abs, root, ci))
      return "";
    return;
  };
  const f = toPosix(file);
  const direct = tryStrip(f, ws);
  if (direct !== undefined)
    return direct;
  for (const base of bases) {
    const b = toPosix(base);
    const joined = isAbsolute(f) ? f : toPosix(`${b}/${f}`);
    const stripped = tryStrip(joined, ws);
    if (stripped !== undefined)
      return stripped;
  }
  const wsNoDrive = ws.replace(/^[a-z]:/, "").replace(/^\//, "");
  const noDrive = tryStrip(f.replace(/^[a-z]:/, "").replace(/^\//, ""), wsNoDrive);
  if (noDrive !== undefined)
    return noDrive;
  return f.replace(/^[a-z]:/, "").replace(/^\/+/, "");
}
function workspaceRelative(file, workspace, bases = [], exists) {
  const ws = toPosix(workspace);
  const ci = /^[a-z]:/.test(ws) || /^[a-zA-Z]:/.test(file);
  const strip = (abs) => {
    const r = ws.endsWith("/") ? ws : `${ws}/`;
    if (abs.length > r.length && sameFs(abs.slice(0, r.length), r, ci))
      return abs.slice(r.length);
    return;
  };
  const f = toPosix(file);
  if (isAbsolute(f))
    return strip(f);
  if (!bases.length)
    return f || undefined;
  const candidates = bases.map((b) => toPosix(`${b.replace(/[\\/]+$/, "")}/${f}`));
  const ordered = exists ? [
    ...candidates.filter((c) => exists(c)),
    ...candidates.filter((c) => !exists(c))
  ] : candidates;
  for (const c of ordered) {
    if (!isAbsolute(c))
      return c;
    const rel = strip(c);
    if (rel !== undefined)
      return rel;
  }
  return;
}
function isAbsolute(p) {
  return p.startsWith("/") || /^[a-zA-Z]:/.test(p);
}

// src/readers/xml.ts
function parseXml(text, arrays) {
  const always = new Set(arrays);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    textNodeName: "#text",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    cdataPropName: false,
    processEntities: true,
    isArray: (name) => always.has(name)
  });
  return parser.parse(text);
}
function attr(node, name) {
  if (!node || typeof node !== "object")
    return;
  const v = node[`@${name}`];
  return v === undefined || v === null ? undefined : String(v);
}
function text(node) {
  if (node === undefined || node === null)
    return;
  if (typeof node === "string")
    return node;
  if (typeof node === "object") {
    const t = node["#text"];
    if (t !== undefined)
      return String(t);
  }
  return;
}
function children(node, name) {
  if (!node || typeof node !== "object")
    return [];
  const v = node[name];
  if (v === undefined || v === null)
    return [];
  if (Array.isArray(v))
    return v.map((x) => typeof x === "object" && x ? x : {});
  return [typeof v === "object" ? v : {}];
}
function secondsToMs(v) {
  if (!v)
    return 0;
  const n = Number.parseFloat(v.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

// src/coverage/cobertura.ts
function isCobertura(xml) {
  return /<coverage[\s>]/.test(xml.slice(0, 64 * 1024));
}
function isJacoco(xml) {
  return /<!DOCTYPE report|<report[\s>]/.test(xml.slice(0, 64 * 1024));
}
function conditionBits(cc) {
  const m = cc ? /\((\d+)\s*\/\s*(\d+)\)/.exec(cc) : null;
  if (!m)
    return;
  const total = Math.min(Number(m[2]), LIMITS.branchesPerLine);
  const hit = Math.min(Number(m[1]), total);
  if (!total)
    return;
  return "1".repeat(hit) + "0".repeat(total - hit);
}
function readCobertura(xml) {
  const doc = parseXml(xml, [
    "source",
    "package",
    "class",
    "line"
  ]);
  const root = doc.coverage;
  if (!root)
    throw new Error("no <coverage> root element");
  const rawSources = children(root, "sources")[0]?.source;
  const bases = (Array.isArray(rawSources) ? rawSources : [rawSources]).map((s) => text(s)?.trim() ?? "").filter(Boolean);
  const files = new Map;
  let lines = 0;
  for (const pkg of children(children(root, "packages")[0], "package"))
    for (const cls of children(children(pkg, "classes")[0], "class")) {
      const name = attr(cls, "filename")?.trim();
      if (!name)
        continue;
      let file = files.get(name);
      if (!file) {
        if (files.size >= LIMITS.files)
          throw new Error(`more than ${LIMITS.files} files in a Cobertura report`);
        file = new Map;
        files.set(name, file);
      }
      for (const l of children(children(cls, "lines")[0], "line")) {
        const n = Number(attr(l, "number"));
        if (!Number.isInteger(n) || n < 1)
          continue;
        if (++lines > LIMITS.lines)
          throw new Error(`more than ${LIMITS.lines} lines in a Cobertura report`);
        const h = Number(attr(l, "hits"));
        const br = attr(l, "branch") === "true" ? conditionBits(attr(l, "condition-coverage")) : undefined;
        addLine(file, n, {
          hits: Number.isFinite(h) && h > 0 ? h : 0,
          ...br ? { br } : {}
        });
      }
    }
  return { files, bases };
}

// src/coverage/lcov.ts
function isLcov(text) {
  return /^(?:TN|SF):/m.test(text.slice(0, 64 * 1024));
}
function readLcov(text) {
  const files = new Map;
  let file;
  let branches = new Map;
  let lines = 0;
  const flush = () => {
    if (!file)
      return;
    for (const [line, list] of branches) {
      const br = list.slice(0, LIMITS.branchesPerLine).map(([, , taken]) => taken ? "1" : "0").join("");
      const cur = file.get(line);
      if (cur)
        cur.br = orBranches(cur.br, br);
      else
        file.set(line, { hits: -1, br });
    }
    branches = new Map;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      const name = line.slice(3).trim();
      file = files.get(name);
      if (!file) {
        if (files.size >= LIMITS.files)
          throw new Error(`more than ${LIMITS.files} files in an lcov report`);
        file = new Map;
        files.set(name, file);
      }
    } else if (line === "end_of_record") {
      flush();
      file = undefined;
    } else if (!file) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      const ln = Number(n);
      if (!Number.isInteger(ln) || ln < 1)
        continue;
      if (++lines > LIMITS.lines)
        throw new Error(`more than ${LIMITS.lines} lines in an lcov report`);
      const h = Number(hits);
      addLine(file, ln, { hits: Number.isFinite(h) && h > 0 ? h : 0 });
    } else if (line.startsWith("BRDA:")) {
      const [n, block, branch, taken] = line.slice(5).split(",");
      const ln = Number(n);
      if (!Number.isInteger(ln) || ln < 1 || block === undefined)
        continue;
      const list = branches.get(ln) ?? [];
      list.push([block, branch ?? "", taken !== "-" && Number(taken) > 0]);
      branches.set(ln, list);
    }
  }
  flush();
  return { files, bases: [] };
}

// src/coverage/read.ts
var MAX_BYTES = 512 * 1024 * 1024;
function parseCoverageFormat(raw) {
  const v = raw.trim().toLowerCase();
  if (!v || v === "auto")
    return;
  if (COVERAGE_FORMAT_LIST.includes(v))
    return v;
  throw new Error(`Unknown coverage format ${JSON.stringify(raw)} (expected auto, ${COVERAGE_FORMAT_LIST.join(", ")})`);
}
function detectCoverage(body, name, forced) {
  const trimmed = body.trimStart();
  if (forced === "cobertura" || !forced && trimmed.startsWith("<")) {
    if (!forced && !isCobertura(trimmed)) {
      if (isJacoco(trimmed))
        throw new Error(`${name}: JaCoCo XML isn't supported; have JaCoCo write Cobertura or lcov, or convert it first`);
      throw new Error(`${name}: XML, but not a Cobertura <coverage> report`);
    }
    return { format: "cobertura", raw: readCobertura(body) };
  }
  if (forced === "lcov" || isLcov(trimmed))
    return { format: "lcov", raw: readLcov(body) };
  throw new Error(`${name}: not lcov or Cobertura; can't detect the coverage format`);
}
function resolveRaw(raw, workspace, exists = existsSync) {
  const coverage = new Map;
  let external = 0;
  for (const [name, file] of raw.files) {
    const rel = workspaceRelative(name, workspace, raw.bases, exists);
    if (rel === undefined || rel.startsWith("../")) {
      external++;
      continue;
    }
    mergeCoverage(coverage, new Map([[rel, file]]));
  }
  if (!coverage.size && raw.files.size) {
    const relativeNames = [...raw.files].filter(([n]) => !/^([a-zA-Z]:|[\\/])/.test(n));
    if (relativeNames.length) {
      for (const [name, file] of relativeNames)
        mergeCoverage(coverage, new Map([[toPosix(name), file]]));
      return {
        coverage,
        external: raw.files.size - relativeNames.length,
        keptRelative: true
      };
    }
  }
  return { coverage, external, keptRelative: false };
}
async function readCoveragePaths(paths, workspace, forced) {
  const out = { sources: [], coverage: new Map, warnings: [] };
  for (const p of paths) {
    const s = await stat(p);
    if (s.isDirectory())
      continue;
    if (s.size > MAX_BYTES)
      throw new Error(`${p} is ${s.size} bytes; refusing to parse more than ${MAX_BYTES}`);
    const body = (await readFile(p, "utf8")).replace(/^﻿/, "");
    const shown = toPosix(relative(workspace, p)) || p;
    const { format, raw } = detectCoverage(body, shown, forced);
    const r = resolveRaw(raw, workspace);
    if (r.keptRelative)
      out.warnings.push(`${shown}: no file resolved inside the workspace, so its relative names were kept as written`);
    else if (raw.files.size && !r.coverage.size)
      out.warnings.push(`${shown}: every file is outside the workspace (${toPosix(workspace)}); nothing kept`);
    mergeCoverage(out.coverage, r.coverage);
    out.sources.push({
      format,
      path: shown,
      files: r.coverage.size,
      external: r.external
    });
  }
  return out;
}

// src/collect/gather.ts
import { createHash } from "node:crypto";
import { relative as relative2 } from "node:path";

// node_modules/@actions/glob/lib/internal-globber.js
import * as fs from "fs";

// node_modules/@actions/glob/lib/internal-glob-options-helper.js
function getOptions(copy) {
  const result = {
    followSymbolicLinks: true,
    implicitDescendants: true,
    matchDirectories: true,
    omitBrokenSymbolicLinks: true,
    excludeHiddenFiles: false
  };
  if (copy) {
    if (typeof copy.followSymbolicLinks === "boolean") {
      result.followSymbolicLinks = copy.followSymbolicLinks;
      debug(`followSymbolicLinks '${result.followSymbolicLinks}'`);
    }
    if (typeof copy.implicitDescendants === "boolean") {
      result.implicitDescendants = copy.implicitDescendants;
      debug(`implicitDescendants '${result.implicitDescendants}'`);
    }
    if (typeof copy.matchDirectories === "boolean") {
      result.matchDirectories = copy.matchDirectories;
      debug(`matchDirectories '${result.matchDirectories}'`);
    }
    if (typeof copy.omitBrokenSymbolicLinks === "boolean") {
      result.omitBrokenSymbolicLinks = copy.omitBrokenSymbolicLinks;
      debug(`omitBrokenSymbolicLinks '${result.omitBrokenSymbolicLinks}'`);
    }
    if (typeof copy.excludeHiddenFiles === "boolean") {
      result.excludeHiddenFiles = copy.excludeHiddenFiles;
      debug(`excludeHiddenFiles '${result.excludeHiddenFiles}'`);
    }
  }
  return result;
}

// node_modules/@actions/glob/lib/internal-globber.js
import * as path5 from "path";

// node_modules/@actions/glob/lib/internal-path-helper.js
import * as path from "path";
import assert from "assert";
var IS_WINDOWS = process.platform === "win32";
function dirname2(p) {
  p = safeTrimTrailingSeparator(p);
  if (IS_WINDOWS && /^\\\\[^\\]+(\\[^\\]+)?$/.test(p)) {
    return p;
  }
  let result = path.dirname(p);
  if (IS_WINDOWS && /^\\\\[^\\]+\\[^\\]+\\$/.test(result)) {
    result = safeTrimTrailingSeparator(result);
  }
  return result;
}
function ensureAbsoluteRoot(root, itemPath) {
  assert(root, `ensureAbsoluteRoot parameter 'root' must not be empty`);
  assert(itemPath, `ensureAbsoluteRoot parameter 'itemPath' must not be empty`);
  if (hasAbsoluteRoot(itemPath)) {
    return itemPath;
  }
  if (IS_WINDOWS) {
    if (itemPath.match(/^[A-Z]:[^\\/]|^[A-Z]:$/i)) {
      let cwd = process.cwd();
      assert(cwd.match(/^[A-Z]:\\/i), `Expected current directory to start with an absolute drive root. Actual '${cwd}'`);
      if (itemPath[0].toUpperCase() === cwd[0].toUpperCase()) {
        if (itemPath.length === 2) {
          return `${itemPath[0]}:\\${cwd.substr(3)}`;
        } else {
          if (!cwd.endsWith("\\")) {
            cwd += "\\";
          }
          return `${itemPath[0]}:\\${cwd.substr(3)}${itemPath.substr(2)}`;
        }
      } else {
        return `${itemPath[0]}:\\${itemPath.substr(2)}`;
      }
    } else if (normalizeSeparators(itemPath).match(/^\\$|^\\[^\\]/)) {
      const cwd = process.cwd();
      assert(cwd.match(/^[A-Z]:\\/i), `Expected current directory to start with an absolute drive root. Actual '${cwd}'`);
      return `${cwd[0]}:\\${itemPath.substr(1)}`;
    }
  }
  assert(hasAbsoluteRoot(root), `ensureAbsoluteRoot parameter 'root' must have an absolute root`);
  if (root.endsWith("/") || IS_WINDOWS && root.endsWith("\\")) {} else {
    root += path.sep;
  }
  return root + itemPath;
}
function hasAbsoluteRoot(itemPath) {
  assert(itemPath, `hasAbsoluteRoot parameter 'itemPath' must not be empty`);
  itemPath = normalizeSeparators(itemPath);
  if (IS_WINDOWS) {
    return itemPath.startsWith("\\\\") || /^[A-Z]:\\/i.test(itemPath);
  }
  return itemPath.startsWith("/");
}
function hasRoot(itemPath) {
  assert(itemPath, `isRooted parameter 'itemPath' must not be empty`);
  itemPath = normalizeSeparators(itemPath);
  if (IS_WINDOWS) {
    return itemPath.startsWith("\\") || /^[A-Z]:/i.test(itemPath);
  }
  return itemPath.startsWith("/");
}
function normalizeSeparators(p) {
  p = p || "";
  if (IS_WINDOWS) {
    p = p.replace(/\//g, "\\");
    const isUnc = /^\\\\+[^\\]/.test(p);
    return (isUnc ? "\\" : "") + p.replace(/\\\\+/g, "\\");
  }
  return p.replace(/\/\/+/g, "/");
}
function safeTrimTrailingSeparator(p) {
  if (!p) {
    return "";
  }
  p = normalizeSeparators(p);
  if (!p.endsWith(path.sep)) {
    return p;
  }
  if (p === path.sep) {
    return p;
  }
  if (IS_WINDOWS && /^[A-Z]:\\$/i.test(p)) {
    return p;
  }
  return p.substr(0, p.length - 1);
}

// node_modules/@actions/glob/lib/internal-match-kind.js
var MatchKind;
(function(MatchKind) {
  MatchKind[MatchKind["None"] = 0] = "None";
  MatchKind[MatchKind["Directory"] = 1] = "Directory";
  MatchKind[MatchKind["File"] = 2] = "File";
  MatchKind[MatchKind["All"] = 3] = "All";
})(MatchKind || (MatchKind = {}));

// node_modules/@actions/glob/lib/internal-pattern-helper.js
var IS_WINDOWS2 = process.platform === "win32";
function getSearchPaths(patterns) {
  patterns = patterns.filter((x) => !x.negate);
  const searchPathMap = {};
  for (const pattern of patterns) {
    const key = IS_WINDOWS2 ? pattern.searchPath.toUpperCase() : pattern.searchPath;
    searchPathMap[key] = "candidate";
  }
  const result = [];
  for (const pattern of patterns) {
    const key = IS_WINDOWS2 ? pattern.searchPath.toUpperCase() : pattern.searchPath;
    if (searchPathMap[key] === "included") {
      continue;
    }
    let foundAncestor = false;
    let tempKey = key;
    let parent = dirname2(tempKey);
    while (parent !== tempKey) {
      if (searchPathMap[parent]) {
        foundAncestor = true;
        break;
      }
      tempKey = parent;
      parent = dirname2(tempKey);
    }
    if (!foundAncestor) {
      result.push(pattern.searchPath);
      searchPathMap[key] = "included";
    }
  }
  return result;
}
function match(patterns, itemPath) {
  let result = MatchKind.None;
  for (const pattern of patterns) {
    if (pattern.negate) {
      result &= ~pattern.match(itemPath);
    } else {
      result |= pattern.match(itemPath);
    }
  }
  return result;
}
function partialMatch(patterns, itemPath) {
  return patterns.some((x) => !x.negate && x.partialMatch(itemPath));
}

// node_modules/@actions/glob/lib/internal-pattern.js
import * as os from "os";
import * as path4 from "path";
import assert3 from "assert";

// node_modules/balanced-match/dist/esm/index.js
var balanced = (a, b, str) => {
  const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
  const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
  const r = ma !== null && mb != null && range(ma, mb, str);
  return r && {
    start: r[0],
    end: r[1],
    pre: str.slice(0, r[0]),
    body: str.slice(r[0] + ma.length, r[1]),
    post: str.slice(r[1] + mb.length)
  };
};
var maybeMatch = (reg, str) => {
  const m = str.match(reg);
  return m ? m[0] : null;
};
var range = (a, b, str) => {
  let begs, beg, left, right = undefined, result;
  let ai = str.indexOf(a);
  let bi = str.indexOf(b, ai + 1);
  let i = ai;
  if (ai >= 0 && bi > 0) {
    if (a === b) {
      return [ai, bi];
    }
    begs = [];
    left = str.length;
    while (i >= 0 && !result) {
      if (i === ai) {
        begs.push(i);
        ai = str.indexOf(a, i + 1);
      } else if (begs.length === 1) {
        const r = begs.pop();
        if (r !== undefined)
          result = [r, bi];
      } else {
        beg = begs.pop();
        if (beg !== undefined && beg < left) {
          left = beg;
          right = bi;
        }
        bi = str.indexOf(b, i + 1);
      }
      i = ai < bi && ai >= 0 ? ai : bi;
    }
    if (begs.length && right !== undefined) {
      result = [left, right];
    }
  }
  return result;
};

// node_modules/brace-expansion/dist/esm/index.js
var escSlash = "\x00SLASH" + Math.random() + "\x00";
var escOpen = "\x00OPEN" + Math.random() + "\x00";
var escClose = "\x00CLOSE" + Math.random() + "\x00";
var escComma = "\x00COMMA" + Math.random() + "\x00";
var escPeriod = "\x00PERIOD" + Math.random() + "\x00";
var escSlashPattern = new RegExp(escSlash, "g");
var escOpenPattern = new RegExp(escOpen, "g");
var escClosePattern = new RegExp(escClose, "g");
var escCommaPattern = new RegExp(escComma, "g");
var escPeriodPattern = new RegExp(escPeriod, "g");
var slashPattern = /\\\\/g;
var openPattern = /\\{/g;
var closePattern = /\\}/g;
var commaPattern = /\\,/g;
var periodPattern = /\\\./g;
var EXPANSION_MAX = 1e5;
var EXPANSION_MAX_LENGTH = 4000000;
var EXPANSION_MAX_DEPTH = 1000;
var EXPANSION_MAX_REWRITES = 1000;
function numeric(str) {
  return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
  return str.replace(slashPattern, escSlash).replace(openPattern, escOpen).replace(closePattern, escClose).replace(commaPattern, escComma).replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
  return str.replace(escSlashPattern, "\\").replace(escOpenPattern, "{").replace(escClosePattern, "}").replace(escCommaPattern, ",").replace(escPeriodPattern, ".");
}
function pushAll(target, items) {
  for (let i = 0;i < items.length; i++) {
    target.push(items[i]);
  }
}
function parseCommaParts(str) {
  const parts = [];
  let carry = "";
  for (;; ) {
    const m = balanced("{", "}", str);
    if (!m) {
      const tail = str.split(",");
      tail[0] = carry + tail[0];
      pushAll(parts, tail);
      return parts;
    }
    const { pre, body, post } = m;
    const p = pre.split(",");
    p[0] = carry + p[0];
    p[p.length - 1] += "{" + body + "}";
    if (!post.length) {
      pushAll(parts, p);
      return parts;
    }
    carry = p.pop();
    pushAll(parts, p);
    str = post;
  }
}
function expand(str, options = {}) {
  if (!str) {
    return [];
  }
  const { max = EXPANSION_MAX, maxLength = EXPANSION_MAX_LENGTH, maxDepth = EXPANSION_MAX_DEPTH, maxRewrites = EXPANSION_MAX_REWRITES } = options;
  if (str.slice(0, 2) === "{}") {
    str = "\\{\\}" + str.slice(2);
  }
  return expand_(escapeBraces(str), max, maxLength, maxDepth, 0, maxRewrites, true).map(unescapeBraces);
}
function embrace(str) {
  return "{" + str + "}";
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}
function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}
function combine(acc, pre, values, max, maxLength, dropEmpties) {
  const out = [];
  let length = 0;
  for (let a = 0;a < acc.length; a++) {
    for (let v = 0;v < values.length; v++) {
      if (out.length >= max)
        return out;
      const expansion = acc[a] + pre + values[v];
      if (dropEmpties && !expansion)
        continue;
      if (length + expansion.length > maxLength)
        return out;
      out.push(expansion);
      length += expansion.length;
    }
  }
  return out;
}
function expandSequence(body, isAlphaSequence, max, maxLength) {
  const n = body.split(/\.\./);
  const N = [];
  if (n[0] === undefined || n[1] === undefined) {
    return N;
  }
  const x = numeric(n[0]);
  const y = numeric(n[1]);
  const width = Math.max(n[0].length, n[1].length);
  let incr = n.length === 3 && n[2] !== undefined ? Math.max(Math.abs(numeric(n[2])), 1) : 1;
  let test = lte;
  const reverse = y < x;
  if (reverse) {
    incr *= -1;
    test = gte;
  }
  const pad = n.some(isPadded);
  let length = 0;
  for (let i = x;test(i, y) && N.length < max; i += incr) {
    let c;
    if (isAlphaSequence) {
      c = String.fromCharCode(i);
      if (c === "\\") {
        c = "";
      }
    } else {
      c = String(i);
      if (pad) {
        const need = width - c.length;
        if (need > 0) {
          const z = new Array(need + 1).join("0");
          if (i < 0) {
            c = "-" + z + c.slice(1);
          } else {
            c = z + c;
          }
        }
      }
    }
    if (length + c.length > maxLength)
      break;
    N.push(c);
    length += c.length;
  }
  return N;
}
function expand_(str, max, maxLength, maxDepth, depth, maxRewrites, isTop) {
  if (depth > maxDepth) {
    return [str];
  }
  let acc = [""];
  let rewrites = 0;
  let dropEmpties = false;
  let firstGroup = true;
  for (;; ) {
    const m = balanced("{", "}", str);
    if (!m) {
      return combine(acc, str, [""], max, maxLength, dropEmpties);
    }
    const pre = m.pre;
    if (/\$$/.test(pre)) {
      acc = combine(acc, pre + "{" + m.body + "}", [""], max, maxLength, dropEmpties && !m.post.length);
      firstGroup = false;
      if (!m.post.length)
        break;
      str = m.post;
      continue;
    }
    const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
    const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
    const isSequence = isNumericSequence || isAlphaSequence;
    const isOptions = m.body.indexOf(",") >= 0;
    if (!isSequence && !isOptions) {
      if (rewrites < maxRewrites && m.post.match(/,(?!,).*\}/)) {
        rewrites++;
        str = m.pre + "{" + m.body + escClose + m.post;
        isTop = true;
        continue;
      }
      return combine(acc, pre + "{" + m.body + "}" + m.post, [""], max, maxLength, dropEmpties);
    }
    if (firstGroup) {
      dropEmpties = isTop && !isSequence;
      firstGroup = false;
    }
    let values;
    if (isSequence) {
      values = expandSequence(m.body, isAlphaSequence, max, maxLength);
    } else {
      let n = parseCommaParts(m.body);
      if (n.length === 1 && n[0] !== undefined) {
        n = expand_(n[0], max, maxLength, maxDepth, depth + 1, maxRewrites, false).map(embrace);
        if (n.length === 1) {
          acc = combine(acc, pre + n[0], [""], max, maxLength, dropEmpties && !m.post.length);
          if (!m.post.length)
            break;
          str = m.post;
          continue;
        }
      }
      let dropsEmpties = dropEmpties && !m.post.length && !pre;
      for (let d = 0;dropsEmpties && d < acc.length; d++) {
        if (acc[d]) {
          dropsEmpties = false;
        }
      }
      values = [];
      let valuesLength = 0;
      outer:
        for (let j = 0;j < n.length; j++) {
          const expanded = expand_(n[j], max, maxLength, maxDepth, depth + 1, maxRewrites, false);
          for (let k = 0;k < expanded.length; k++) {
            const v = expanded[k];
            if (dropsEmpties && !v)
              continue;
            if (values.length >= max || valuesLength + v.length > maxLength) {
              break outer;
            }
            values.push(v);
            valuesLength += v.length;
          }
        }
    }
    acc = combine(acc, pre, values, max, maxLength, dropEmpties && !m.post.length);
    if (!m.post.length)
      break;
    str = m.post;
  }
  return acc;
}

// node_modules/minimatch/dist/esm/assert-valid-pattern.js
var MAX_PATTERN_LENGTH = 1024 * 64;
var assertValidPattern = (pattern) => {
  if (typeof pattern !== "string") {
    throw new TypeError("invalid pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new TypeError("pattern is too long");
  }
};

// node_modules/minimatch/dist/esm/brace-expressions.js
var posixClasses = {
  "[:alnum:]": ["\\p{L}\\p{Nl}\\p{Nd}", true],
  "[:alpha:]": ["\\p{L}\\p{Nl}", true],
  "[:ascii:]": ["\\x" + "00-\\x" + "7f", false],
  "[:blank:]": ["\\p{Zs}\\t", true],
  "[:cntrl:]": ["\\p{Cc}", true],
  "[:digit:]": ["\\p{Nd}", true],
  "[:graph:]": ["\\p{Z}\\p{C}", true, true],
  "[:lower:]": ["\\p{Ll}", true],
  "[:print:]": ["\\p{C}", true],
  "[:punct:]": ["\\p{P}", true],
  "[:space:]": ["\\p{Z}\\t\\r\\n\\v\\f", true],
  "[:upper:]": ["\\p{Lu}", true],
  "[:word:]": ["\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", true],
  "[:xdigit:]": ["A-Fa-f0-9", false]
};
var braceEscape = (s) => s.replace(/[[\]\\-]/g, "\\$&");
var regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var rangesToString = (ranges) => ranges.join("");
var parseClass = (glob, position) => {
  const pos = position;
  if (glob.charAt(pos) !== "[") {
    throw new Error("not in a brace expression");
  }
  const ranges = [];
  const negs = [];
  let i = pos + 1;
  let sawStart = false;
  let uflag = false;
  let escaping = false;
  let negate = false;
  let endPos = pos;
  let rangeStart = "";
  WHILE:
    while (i < glob.length) {
      const c = glob.charAt(i);
      if ((c === "!" || c === "^") && i === pos + 1) {
        negate = true;
        i++;
        continue;
      }
      if (c === "]" && sawStart && !escaping) {
        endPos = i + 1;
        break;
      }
      sawStart = true;
      if (c === "\\") {
        if (!escaping) {
          escaping = true;
          i++;
          continue;
        }
      }
      if (c === "[" && !escaping) {
        for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
          if (glob.startsWith(cls, i)) {
            if (rangeStart) {
              return ["$.", false, glob.length - pos, true];
            }
            i += cls.length;
            if (neg)
              negs.push(unip);
            else
              ranges.push(unip);
            uflag = uflag || u;
            continue WHILE;
          }
        }
      }
      escaping = false;
      if (rangeStart) {
        if (c > rangeStart) {
          ranges.push(braceEscape(rangeStart) + "-" + braceEscape(c));
        } else if (c === rangeStart) {
          ranges.push(braceEscape(c));
        }
        rangeStart = "";
        i++;
        continue;
      }
      if (glob.startsWith("-]", i + 1)) {
        ranges.push(braceEscape(c + "-"));
        i += 2;
        continue;
      }
      if (glob.startsWith("-", i + 1)) {
        rangeStart = c;
        i += 2;
        continue;
      }
      ranges.push(braceEscape(c));
      i++;
    }
  if (endPos < i) {
    return ["", false, 0, false];
  }
  if (!ranges.length && !negs.length) {
    return ["$.", false, glob.length - pos, true];
  }
  if (negs.length === 0 && ranges.length === 1 && /^\\?.$/.test(ranges[0]) && !negate) {
    const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
    return [regexpEscape(r), false, endPos - pos, false];
  }
  const sranges = "[" + (negate ? "^" : "") + rangesToString(ranges) + "]";
  const snegs = "[" + (negate ? "" : "^") + rangesToString(negs) + "]";
  const comb = ranges.length && negs.length ? "(" + sranges + "|" + snegs + ")" : ranges.length ? sranges : snegs;
  return [comb, uflag, endPos - pos, true];
};

// node_modules/minimatch/dist/esm/unescape.js
var unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/\[([^/\\])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\])\]/g, "$1$2").replace(/\\([^/])/g, "$1");
  }
  return windowsPathsNoEscape ? s.replace(/\[([^/\\{}])\]/g, "$1") : s.replace(/((?!\\).|^)\[([^/\\{}])\]/g, "$1$2").replace(/\\([^/{}])/g, "$1");
};

// node_modules/minimatch/dist/esm/ast.js
var _a;
var types = new Set(["!", "?", "+", "*", "@"]);
var isExtglobType = (c) => types.has(c);
var isExtglobAST = (c) => isExtglobType(c.type);
var adoptionMap = new Map([
  ["!", ["@"]],
  ["?", ["?", "@"]],
  ["@", ["@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@"]]
]);
var adoptionWithSpaceMap = new Map([
  ["!", ["?"]],
  ["@", ["?"]],
  ["+", ["?", "*"]]
]);
var adoptionAnyMap = new Map([
  ["!", ["?", "@"]],
  ["?", ["?", "@"]],
  ["@", ["?", "@"]],
  ["*", ["*", "+", "?", "@"]],
  ["+", ["+", "@", "?", "*"]]
]);
var usurpMap = new Map([
  ["!", new Map([["!", "@"]])],
  [
    "?",
    new Map([
      ["*", "*"],
      ["+", "*"]
    ])
  ],
  [
    "@",
    new Map([
      ["!", "!"],
      ["?", "?"],
      ["@", "@"],
      ["*", "*"],
      ["+", "+"]
    ])
  ],
  [
    "+",
    new Map([
      ["?", "*"],
      ["*", "*"]
    ])
  ]
]);
var startNoTraversal = "(?!(?:^|/)\\.\\.?(?:$|/))";
var startNoDot = "(?!\\.)";
var addPatternStart = new Set(["[", "."]);
var justDots = new Set(["..", "."]);
var reSpecials = new Set("().*{}+?[]^$\\!");
var regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
var qmark = "[^/]";
var star = qmark + "*?";
var starNoEmpty = qmark + "+?";
var ID = 0;

class AST {
  type;
  #root;
  #hasMagic;
  #uflag = false;
  #parts = [];
  #parent;
  #parentIndex;
  #negs;
  #filledNegs = false;
  #options;
  #toString;
  #emptyExt = false;
  id = ++ID;
  get depth() {
    return (this.#parent?.depth ?? -1) + 1;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return {
      "@@type": "AST",
      id: this.id,
      type: this.type,
      root: this.#root.id,
      parent: this.#parent?.id,
      depth: this.depth,
      partsLength: this.#parts.length,
      parts: this.#parts
    };
  }
  constructor(type, parent, options = {}) {
    this.type = type;
    if (type)
      this.#hasMagic = true;
    this.#parent = parent;
    this.#root = this.#parent ? this.#parent.#root : this;
    this.#options = this.#root === this ? options : this.#root.#options;
    this.#negs = this.#root === this ? [] : this.#root.#negs;
    if (type === "!" && !this.#root.#filledNegs)
      this.#negs.push(this);
    this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
  }
  get hasMagic() {
    if (this.#hasMagic !== undefined)
      return this.#hasMagic;
    for (const p of this.#parts) {
      if (typeof p === "string")
        continue;
      if (p.type || p.hasMagic)
        return this.#hasMagic = true;
    }
    return this.#hasMagic;
  }
  toString() {
    return this.#toString !== undefined ? this.#toString : !this.type ? this.#toString = this.#parts.map((p) => String(p)).join("") : this.#toString = this.type + "(" + this.#parts.map((p) => String(p)).join("|") + ")";
  }
  #fillNegs() {
    if (this !== this.#root)
      throw new Error("should only call on root");
    if (this.#filledNegs)
      return this;
    this.toString();
    this.#filledNegs = true;
    let n;
    while (n = this.#negs.pop()) {
      if (n.type !== "!")
        continue;
      let p = n;
      let pp = p.#parent;
      while (pp) {
        for (let i = p.#parentIndex + 1;!pp.type && i < pp.#parts.length; i++) {
          for (const part of n.#parts) {
            if (typeof part === "string") {
              throw new Error("string part in extglob AST??");
            }
            part.copyIn(pp.#parts[i]);
          }
        }
        p = pp;
        pp = p.#parent;
      }
    }
    return this;
  }
  push(...parts) {
    for (const p of parts) {
      if (p === "")
        continue;
      if (typeof p !== "string" && !(p instanceof _a && p.#parent === this)) {
        throw new Error("invalid part: " + p);
      }
      this.#parts.push(p);
    }
  }
  toJSON() {
    const ret = this.type === null ? this.#parts.slice().map((p) => typeof p === "string" ? p : p.toJSON()) : [this.type, ...this.#parts.map((p) => p.toJSON())];
    if (this.isStart() && !this.type)
      ret.unshift([]);
    if (this.isEnd() && (this === this.#root || this.#root.#filledNegs && this.#parent?.type === "!")) {
      ret.push({});
    }
    return ret;
  }
  isStart() {
    if (this.#root === this)
      return true;
    if (!this.#parent?.isStart())
      return false;
    if (this.#parentIndex === 0)
      return true;
    const p = this.#parent;
    for (let i = 0;i < this.#parentIndex; i++) {
      const pp = p.#parts[i];
      if (!(pp instanceof _a && pp.type === "!")) {
        return false;
      }
    }
    return true;
  }
  isEnd() {
    if (this.#root === this)
      return true;
    if (this.#parent?.type === "!")
      return true;
    if (!this.#parent?.isEnd())
      return false;
    if (!this.type)
      return this.#parent?.isEnd();
    const pl = this.#parent ? this.#parent.#parts.length : 0;
    return this.#parentIndex === pl - 1;
  }
  copyIn(part) {
    if (typeof part === "string")
      this.push(part);
    else
      this.push(part.clone(this));
  }
  clone(parent) {
    const c = new _a(this.type, parent);
    for (const p of this.#parts) {
      c.copyIn(p);
    }
    return c;
  }
  static #parseAST(str, ast, pos, opt, extDepth) {
    const maxDepth = opt.maxExtglobRecursion ?? 2;
    let escaping = false;
    let inBrace = false;
    let braceStart = -1;
    let braceNeg = false;
    if (ast.type === null) {
      let i = pos;
      let acc = "";
      while (i < str.length) {
        const c = str.charAt(i++);
        if (escaping || c === "\\") {
          escaping = !escaping;
          acc += c;
          continue;
        }
        if (inBrace) {
          if (i === braceStart + 1) {
            if (c === "^" || c === "!") {
              braceNeg = true;
            }
          } else if (c === "]" && !(i === braceStart + 2 && braceNeg)) {
            inBrace = false;
          }
          acc += c;
          continue;
        } else if (c === "[") {
          inBrace = true;
          braceStart = i;
          braceNeg = false;
          acc += c;
          continue;
        }
        const doRecurse = !opt.noext && isExtglobType(c) && str.charAt(i) === "(" && extDepth <= maxDepth;
        if (doRecurse) {
          ast.push(acc);
          acc = "";
          const ext = new _a(c, ast);
          i = _a.#parseAST(str, ext, i, opt, extDepth + 1);
          ast.push(ext);
          continue;
        }
        acc += c;
      }
      ast.push(acc);
      return i;
    }
    let i = pos + 1;
    let part = new _a(null, ast);
    const parts = [];
    let acc = "";
    while (i < str.length) {
      const c = str.charAt(i++);
      if (escaping || c === "\\") {
        escaping = !escaping;
        acc += c;
        continue;
      }
      if (inBrace) {
        if (i === braceStart + 1) {
          if (c === "^" || c === "!") {
            braceNeg = true;
          }
        } else if (c === "]" && !(i === braceStart + 2 && braceNeg)) {
          inBrace = false;
        }
        acc += c;
        continue;
      } else if (c === "[") {
        inBrace = true;
        braceStart = i;
        braceNeg = false;
        acc += c;
        continue;
      }
      const doRecurse = !opt.noext && isExtglobType(c) && str.charAt(i) === "(" && (extDepth <= maxDepth || ast && ast.#canAdoptType(c));
      if (doRecurse) {
        const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
        part.push(acc);
        acc = "";
        const ext = new _a(c, part);
        part.push(ext);
        i = _a.#parseAST(str, ext, i, opt, extDepth + depthAdd);
        continue;
      }
      if (c === "|") {
        part.push(acc);
        acc = "";
        parts.push(part);
        part = new _a(null, ast);
        continue;
      }
      if (c === ")") {
        if (acc === "" && ast.#parts.length === 0) {
          ast.#emptyExt = true;
        }
        part.push(acc);
        acc = "";
        ast.push(...parts, part);
        return i;
      }
      acc += c;
    }
    ast.type = null;
    ast.#hasMagic = undefined;
    ast.#parts = [str.substring(pos - 1)];
    return i;
  }
  #canAdoptWithSpace(child) {
    return this.#canAdopt(child, adoptionWithSpaceMap);
  }
  #canAdopt(child, map = adoptionMap) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canAdoptType(gc.type, map);
  }
  #canAdoptType(c, map = adoptionAnyMap) {
    return !!map.get(this.type)?.includes(c);
  }
  #adoptWithSpace(child, index) {
    const gc = child.#parts[0];
    const blank = new _a(null, gc, this.options);
    blank.#parts.push("");
    gc.push(blank);
    this.#adopt(child, index);
  }
  #adopt(child, index) {
    const gc = child.#parts[0];
    this.#parts.splice(index, 1, ...gc.#parts);
    for (const p of gc.#parts) {
      if (typeof p === "object")
        p.#parent = this;
    }
    this.#toString = undefined;
  }
  #canUsurpType(c) {
    const m = usurpMap.get(this.type);
    return !!m?.has(c);
  }
  #canUsurp(child) {
    if (!child || typeof child !== "object" || child.type !== null || child.#parts.length !== 1 || this.type === null || this.#parts.length !== 1) {
      return false;
    }
    const gc = child.#parts[0];
    if (!gc || typeof gc !== "object" || gc.type === null) {
      return false;
    }
    return this.#canUsurpType(gc.type);
  }
  #usurp(child) {
    const m = usurpMap.get(this.type);
    const gc = child.#parts[0];
    const nt = m?.get(gc.type);
    if (!nt)
      return false;
    this.#parts = gc.#parts;
    for (const p of this.#parts) {
      if (typeof p === "object") {
        p.#parent = this;
      }
    }
    this.type = nt;
    this.#toString = undefined;
    this.#emptyExt = false;
  }
  static fromGlob(pattern, options = {}) {
    const ast = new _a(null, undefined, options);
    _a.#parseAST(pattern, ast, 0, options, 0);
    return ast;
  }
  toMMPattern() {
    if (this !== this.#root)
      return this.#root.toMMPattern();
    const glob = this.toString();
    const [re, body, hasMagic, uflag] = this.toRegExpSource();
    const anyMagic = hasMagic || this.#hasMagic || this.#options.nocase && !this.#options.nocaseMagicOnly && glob.toUpperCase() !== glob.toLowerCase();
    if (!anyMagic) {
      return body;
    }
    const flags = (this.#options.nocase ? "i" : "") + (uflag ? "u" : "");
    return Object.assign(new RegExp(`^${re}$`, flags), {
      _src: re,
      _glob: glob
    });
  }
  get options() {
    return this.#options;
  }
  toRegExpSource(allowDot) {
    const dot = allowDot ?? !!this.#options.dot;
    if (this.#root === this) {
      this.#flatten();
      this.#fillNegs();
    }
    if (!isExtglobAST(this)) {
      const noEmpty = this.isStart() && this.isEnd() && !this.#parts.some((s) => typeof s !== "string");
      const src = this.#parts.map((p) => {
        const [re, _, hasMagic, uflag] = typeof p === "string" ? _a.#parseGlob(p, this.#hasMagic, noEmpty) : p.toRegExpSource(allowDot);
        this.#hasMagic = this.#hasMagic || hasMagic;
        this.#uflag = this.#uflag || uflag;
        return re;
      }).join("");
      let start = "";
      if (this.isStart()) {
        if (typeof this.#parts[0] === "string") {
          const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
          if (!dotTravAllowed) {
            const aps = addPatternStart;
            const needNoTrav = dot && aps.has(src.charAt(0)) || src.startsWith("\\.") && aps.has(src.charAt(2)) || src.startsWith("\\.\\.") && aps.has(src.charAt(4));
            const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
            start = needNoTrav ? startNoTraversal : needNoDot ? startNoDot : "";
          }
        }
      }
      let end = "";
      if (this.isEnd() && this.#root.#filledNegs && this.#parent?.type === "!") {
        end = "(?:$|\\/)";
      }
      const final = start + src + end;
      return [
        final,
        unescape(src),
        this.#hasMagic = !!this.#hasMagic,
        this.#uflag
      ];
    }
    const repeated = this.type === "*" || this.type === "+";
    const start = this.type === "!" ? "(?:(?!(?:" : "(?:";
    let body = this.#partsToRegExp(dot);
    if (this.isStart() && this.isEnd() && !body && this.type !== "!") {
      const s = this.toString();
      const me = this;
      me.#parts = [s];
      me.type = null;
      me.#hasMagic = undefined;
      return [s, unescape(this.toString()), false, false];
    }
    let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ? "" : this.#partsToRegExp(true);
    if (bodyDotAllowed === body) {
      bodyDotAllowed = "";
    }
    if (bodyDotAllowed) {
      body = `(?:${body})(?:${bodyDotAllowed})*?`;
    }
    let final = "";
    if (this.type === "!" && this.#emptyExt) {
      final = (this.isStart() && !dot ? startNoDot : "") + starNoEmpty;
    } else {
      const close = this.type === "!" ? "))" + (this.isStart() && !dot && !allowDot ? startNoDot : "") + star + ")" : this.type === "@" ? ")" : this.type === "?" ? ")?" : this.type === "+" && bodyDotAllowed ? ")" : this.type === "*" && bodyDotAllowed ? `)?` : `)${this.type}`;
      final = start + body + close;
    }
    return [
      final,
      unescape(body),
      this.#hasMagic = !!this.#hasMagic,
      this.#uflag
    ];
  }
  #flatten() {
    if (!isExtglobAST(this)) {
      for (const p of this.#parts) {
        if (typeof p === "object") {
          p.#flatten();
        }
      }
    } else {
      let iterations = 0;
      let done = false;
      do {
        done = true;
        for (let i = 0;i < this.#parts.length; i++) {
          const c = this.#parts[i];
          if (typeof c === "object") {
            c.#flatten();
            if (this.#canAdopt(c)) {
              done = false;
              this.#adopt(c, i);
            } else if (this.#canAdoptWithSpace(c)) {
              done = false;
              this.#adoptWithSpace(c, i);
            } else if (this.#canUsurp(c)) {
              done = false;
              this.#usurp(c);
            }
          }
        }
      } while (!done && ++iterations < 10);
    }
    this.#toString = undefined;
  }
  #partsToRegExp(dot) {
    return this.#parts.map((p) => {
      if (typeof p === "string") {
        throw new Error("string type in extglob ast??");
      }
      const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
      this.#uflag = this.#uflag || uflag;
      return re;
    }).filter((p) => !(this.isStart() && this.isEnd()) || !!p).join("|");
  }
  static #parseGlob(glob, hasMagic, noEmpty = false) {
    let escaping = false;
    let re = "";
    let uflag = false;
    let inStar = false;
    for (let i = 0;i < glob.length; i++) {
      const c = glob.charAt(i);
      if (escaping) {
        escaping = false;
        re += (reSpecials.has(c) ? "\\" : "") + c;
        continue;
      }
      if (c === "*") {
        if (inStar)
          continue;
        inStar = true;
        re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star;
        hasMagic = true;
        continue;
      } else {
        inStar = false;
      }
      if (c === "\\") {
        if (i === glob.length - 1) {
          re += "\\\\";
        } else {
          escaping = true;
        }
        continue;
      }
      if (c === "[") {
        const [src, needUflag, consumed, magic] = parseClass(glob, i);
        if (consumed) {
          re += src;
          uflag = uflag || needUflag;
          i += consumed - 1;
          hasMagic = hasMagic || magic;
          continue;
        }
      }
      if (c === "?") {
        re += qmark;
        hasMagic = true;
        continue;
      }
      re += regExpEscape(c);
    }
    return [re, unescape(glob), !!hasMagic, uflag];
  }
}
_a = AST;

// node_modules/minimatch/dist/esm/escape.js
var escape = (s, { windowsPathsNoEscape = false, magicalBraces = false } = {}) => {
  if (magicalBraces) {
    return windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, "[$&]") : s.replace(/[?*()[\]\\{}]/g, "\\$&");
  }
  return windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, "[$&]") : s.replace(/[?*()[\]\\]/g, "\\$&");
};

// node_modules/minimatch/dist/esm/index.js
var minimatch = (p, pattern, options = {}) => {
  assertValidPattern(pattern);
  if (!options.nocomment && pattern.charAt(0) === "#") {
    return false;
  }
  return new Minimatch(pattern, options).match(p);
};
var starDotExtRE = /^\*+([^+@!?*[(]*)$/;
var starDotExtTest = (ext) => (f) => !f.startsWith(".") && f.endsWith(ext);
var starDotExtTestDot = (ext) => (f) => f.endsWith(ext);
var starDotExtTestNocase = (ext) => {
  ext = ext.toLowerCase();
  return (f) => !f.startsWith(".") && f.toLowerCase().endsWith(ext);
};
var starDotExtTestNocaseDot = (ext) => {
  ext = ext.toLowerCase();
  return (f) => f.toLowerCase().endsWith(ext);
};
var starDotStarRE = /^\*+\.\*+$/;
var starDotStarTest = (f) => !f.startsWith(".") && f.includes(".");
var starDotStarTestDot = (f) => f !== "." && f !== ".." && f.includes(".");
var dotStarRE = /^\.\*+$/;
var dotStarTest = (f) => f !== "." && f !== ".." && f.startsWith(".");
var starRE = /^\*+$/;
var starTest = (f) => f.length !== 0 && !f.startsWith(".");
var starTestDot = (f) => f.length !== 0 && f !== "." && f !== "..";
var qmarksRE = /^\?+([^+@!?*[(]*)?$/;
var qmarksTestNocase = ([$0, ext = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  if (!ext)
    return noext;
  ext = ext.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
var qmarksTestNocaseDot = ([$0, ext = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  if (!ext)
    return noext;
  ext = ext.toLowerCase();
  return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
var qmarksTestDot = ([$0, ext = ""]) => {
  const noext = qmarksTestNoExtDot([$0]);
  return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
var qmarksTest = ([$0, ext = ""]) => {
  const noext = qmarksTestNoExt([$0]);
  return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
var qmarksTestNoExt = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && !f.startsWith(".");
};
var qmarksTestNoExtDot = ([$0]) => {
  const len = $0.length;
  return (f) => f.length === len && f !== "." && f !== "..";
};
var defaultPlatform = typeof process === "object" && process ? typeof process.env === "object" && process.env && process.env.__MINIMATCH_TESTING_PLATFORM__ || process.platform : "posix";
var path2 = {
  win32: { sep: "\\" },
  posix: { sep: "/" }
};
var sep2 = defaultPlatform === "win32" ? path2.win32.sep : path2.posix.sep;
minimatch.sep = sep2;
var GLOBSTAR = Symbol("globstar **");
minimatch.GLOBSTAR = GLOBSTAR;
var qmark2 = "[^/]";
var star2 = qmark2 + "*?";
var twoStarDot = "(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?";
var twoStarNoDot = "(?:(?!(?:\\/|^)\\.).)*?";
var filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
var ext = (a, b = {}) => Object.assign({}, a, b);
var defaults = (def) => {
  if (!def || typeof def !== "object" || !Object.keys(def).length) {
    return minimatch;
  }
  const orig = minimatch;
  const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
  return Object.assign(m, {
    Minimatch: class Minimatch extends orig.Minimatch {
      constructor(pattern, options = {}) {
        super(pattern, ext(def, options));
      }
      static defaults(options) {
        return orig.defaults(ext(def, options)).Minimatch;
      }
    },
    AST: class AST2 extends orig.AST {
      constructor(type, parent, options = {}) {
        super(type, parent, ext(def, options));
      }
      static fromGlob(pattern, options = {}) {
        return orig.AST.fromGlob(pattern, ext(def, options));
      }
    },
    unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
    escape: (s, options = {}) => orig.escape(s, ext(def, options)),
    filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
    defaults: (options) => orig.defaults(ext(def, options)),
    makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
    braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
    match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
    sep: orig.sep,
    GLOBSTAR
  });
};
minimatch.defaults = defaults;
var braceExpand = (pattern, options = {}) => {
  assertValidPattern(pattern);
  if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
    return [pattern];
  }
  return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
var makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
var match2 = (list, pattern, options = {}) => {
  const mm = new Minimatch(pattern, options);
  list = list.filter((f) => mm.match(f));
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list;
};
minimatch.match = match2;
var globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
var regExpEscape2 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");

class Minimatch {
  options;
  set;
  pattern;
  windowsPathsNoEscape;
  nonegate;
  negate;
  comment;
  empty;
  preserveMultipleSlashes;
  partial;
  globSet;
  globParts;
  nocase;
  isWindows;
  platform;
  windowsNoMagicRoot;
  maxGlobstarRecursion;
  regexp;
  constructor(pattern, options = {}) {
    assertValidPattern(pattern);
    options = options || {};
    this.options = options;
    this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
    this.pattern = pattern;
    this.platform = options.platform || defaultPlatform;
    this.isWindows = this.platform === "win32";
    const awe = "allowWindow" + "sEscape";
    this.windowsPathsNoEscape = !!options.windowsPathsNoEscape || options[awe] === false;
    if (this.windowsPathsNoEscape) {
      this.pattern = this.pattern.replace(/\\/g, "/");
    }
    this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
    this.regexp = null;
    this.negate = false;
    this.nonegate = !!options.nonegate;
    this.comment = false;
    this.empty = false;
    this.partial = !!options.partial;
    this.nocase = !!this.options.nocase;
    this.windowsNoMagicRoot = options.windowsNoMagicRoot !== undefined ? options.windowsNoMagicRoot : !!(this.isWindows && this.nocase);
    this.globSet = [];
    this.globParts = [];
    this.set = [];
    this.make();
  }
  hasMagic() {
    if (this.options.magicalBraces && this.set.length > 1) {
      return true;
    }
    for (const pattern of this.set) {
      for (const part of pattern) {
        if (typeof part !== "string")
          return true;
      }
    }
    return false;
  }
  debug(..._) {}
  make() {
    const pattern = this.pattern;
    const options = this.options;
    if (!options.nocomment && pattern.charAt(0) === "#") {
      this.comment = true;
      return;
    }
    if (!pattern) {
      this.empty = true;
      return;
    }
    this.parseNegate();
    this.globSet = [...new Set(this.braceExpand())];
    if (options.debug) {
      this.debug = (...args) => console.error(...args);
    }
    this.debug(this.pattern, this.globSet);
    const rawGlobParts = this.globSet.map((s) => this.slashSplit(s));
    this.globParts = this.preprocess(rawGlobParts);
    this.debug(this.pattern, this.globParts);
    let set = this.globParts.map((s, _, __) => {
      if (this.isWindows && this.windowsNoMagicRoot) {
        const isUNC = s[0] === "" && s[1] === "" && (s[2] === "?" || !globMagic.test(s[2])) && !globMagic.test(s[3]);
        const isDrive = /^[a-z]:/i.test(s[0]);
        if (isUNC) {
          return [
            ...s.slice(0, 4),
            ...s.slice(4).map((ss) => this.parse(ss))
          ];
        } else if (isDrive) {
          return [s[0], ...s.slice(1).map((ss) => this.parse(ss))];
        }
      }
      return s.map((ss) => this.parse(ss));
    });
    this.debug(this.pattern, set);
    this.set = set.filter((s) => s.indexOf(false) === -1);
    if (this.isWindows) {
      for (let i = 0;i < this.set.length; i++) {
        const p = this.set[i];
        if (p[0] === "" && p[1] === "" && this.globParts[i][2] === "?" && typeof p[3] === "string" && /^[a-z]:$/i.test(p[3])) {
          p[2] = "?";
        }
      }
    }
    this.debug(this.pattern, this.set);
  }
  preprocess(globParts) {
    if (this.options.noglobstar) {
      for (const partset of globParts) {
        for (let j = 0;j < partset.length; j++) {
          if (partset[j] === "**") {
            partset[j] = "*";
          }
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      globParts = this.firstPhasePreProcess(globParts);
      globParts = this.secondPhasePreProcess(globParts);
    } else if (optimizationLevel >= 1) {
      globParts = this.levelOneOptimize(globParts);
    } else {
      globParts = this.adjascentGlobstarOptimize(globParts);
    }
    return globParts;
  }
  adjascentGlobstarOptimize(globParts) {
    return globParts.map((parts) => {
      let gs = -1;
      while ((gs = parts.indexOf("**", gs + 1)) !== -1) {
        let i = gs;
        while (parts[i + 1] === "**") {
          i++;
        }
        if (i !== gs) {
          parts.splice(gs, i - gs);
        }
      }
      return parts;
    });
  }
  levelOneOptimize(globParts) {
    return globParts.map((parts) => {
      parts = parts.reduce((set, part) => {
        const prev = set[set.length - 1];
        if (part === "**" && prev === "**") {
          return set;
        }
        if (part === "..") {
          if (prev && prev !== ".." && prev !== "." && prev !== "**") {
            set.pop();
            return set;
          }
        }
        set.push(part);
        return set;
      }, []);
      return parts.length === 0 ? [""] : parts;
    });
  }
  levelTwoFileOptimize(parts) {
    if (!Array.isArray(parts)) {
      parts = this.slashSplit(parts);
    }
    let didSomething = false;
    do {
      didSomething = false;
      if (!this.preserveMultipleSlashes) {
        for (let i = 1;i < parts.length - 1; i++) {
          const p = parts[i];
          if (i === 1 && p === "" && parts[0] === "")
            continue;
          if (p === "." || p === "") {
            didSomething = true;
            parts.splice(i, 1);
            i--;
          }
        }
        if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
          didSomething = true;
          parts.pop();
        }
      }
      let dd = 0;
      while ((dd = parts.indexOf("..", dd + 1)) !== -1) {
        const p = parts[dd - 1];
        if (p && p !== "." && p !== ".." && p !== "**" && !(this.isWindows && /^[a-z]:$/i.test(p))) {
          didSomething = true;
          parts.splice(dd - 1, 2);
          dd -= 2;
        }
      }
    } while (didSomething);
    return parts.length === 0 ? [""] : parts;
  }
  firstPhasePreProcess(globParts) {
    let didSomething = false;
    do {
      didSomething = false;
      for (let parts of globParts) {
        let gs = -1;
        while ((gs = parts.indexOf("**", gs + 1)) !== -1) {
          let gss = gs;
          while (parts[gss + 1] === "**") {
            gss++;
          }
          if (gss > gs) {
            parts.splice(gs + 1, gss - gs);
          }
          let next = parts[gs + 1];
          const p = parts[gs + 2];
          const p2 = parts[gs + 3];
          if (next !== "..")
            continue;
          if (!p || p === "." || p === ".." || !p2 || p2 === "." || p2 === "..") {
            continue;
          }
          didSomething = true;
          parts.splice(gs, 1);
          const other = parts.slice(0);
          other[gs] = "**";
          globParts.push(other);
          gs--;
        }
        if (!this.preserveMultipleSlashes) {
          for (let i = 1;i < parts.length - 1; i++) {
            const p = parts[i];
            if (i === 1 && p === "" && parts[0] === "")
              continue;
            if (p === "." || p === "") {
              didSomething = true;
              parts.splice(i, 1);
              i--;
            }
          }
          if (parts[0] === "." && parts.length === 2 && (parts[1] === "." || parts[1] === "")) {
            didSomething = true;
            parts.pop();
          }
        }
        let dd = 0;
        while ((dd = parts.indexOf("..", dd + 1)) !== -1) {
          const p = parts[dd - 1];
          if (p && p !== "." && p !== ".." && p !== "**") {
            didSomething = true;
            const needDot = dd === 1 && parts[dd + 1] === "**";
            const splin = needDot ? ["."] : [];
            parts.splice(dd - 1, 2, ...splin);
            if (parts.length === 0)
              parts.push("");
            dd -= 2;
          }
        }
      }
    } while (didSomething);
    return globParts;
  }
  secondPhasePreProcess(globParts) {
    for (let i = 0;i < globParts.length - 1; i++) {
      for (let j = i + 1;j < globParts.length; j++) {
        const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
        if (matched) {
          globParts[i] = [];
          globParts[j] = matched;
          break;
        }
      }
    }
    return globParts.filter((gs) => gs.length);
  }
  partsMatch(a, b, emptyGSMatch = false) {
    let ai = 0;
    let bi = 0;
    let result = [];
    let which = "";
    while (ai < a.length && bi < b.length) {
      if (a[ai] === b[bi]) {
        result.push(which === "b" ? b[bi] : a[ai]);
        ai++;
        bi++;
      } else if (emptyGSMatch && a[ai] === "**" && b[bi] === a[ai + 1]) {
        result.push(a[ai]);
        ai++;
      } else if (emptyGSMatch && b[bi] === "**" && a[ai] === b[bi + 1]) {
        result.push(b[bi]);
        bi++;
      } else if (a[ai] === "*" && b[bi] && (this.options.dot || !b[bi].startsWith(".")) && b[bi] !== "**") {
        if (which === "b")
          return false;
        which = "a";
        result.push(a[ai]);
        ai++;
        bi++;
      } else if (b[bi] === "*" && a[ai] && (this.options.dot || !a[ai].startsWith(".")) && a[ai] !== "**") {
        if (which === "a")
          return false;
        which = "b";
        result.push(b[bi]);
        ai++;
        bi++;
      } else {
        return false;
      }
    }
    return a.length === b.length && result;
  }
  parseNegate() {
    if (this.nonegate)
      return;
    const pattern = this.pattern;
    let negate = false;
    let negateOffset = 0;
    for (let i = 0;i < pattern.length && pattern.charAt(i) === "!"; i++) {
      negate = !negate;
      negateOffset++;
    }
    if (negateOffset)
      this.pattern = pattern.slice(negateOffset);
    this.negate = negate;
  }
  matchOne(file, pattern, partial = false) {
    let fileStartIndex = 0;
    let patternStartIndex = 0;
    if (this.isWindows) {
      const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
      const fileUNC = !fileDrive && file[0] === "" && file[1] === "" && file[2] === "?" && /^[a-z]:$/i.test(file[3]);
      const patternDrive = typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
      const patternUNC = !patternDrive && pattern[0] === "" && pattern[1] === "" && pattern[2] === "?" && typeof pattern[3] === "string" && /^[a-z]:$/i.test(pattern[3]);
      const fdi = fileUNC ? 3 : fileDrive ? 0 : undefined;
      const pdi = patternUNC ? 3 : patternDrive ? 0 : undefined;
      if (typeof fdi === "number" && typeof pdi === "number") {
        const [fd, pd] = [
          file[fdi],
          pattern[pdi]
        ];
        if (fd.toLowerCase() === pd.toLowerCase()) {
          pattern[pdi] = fd;
          patternStartIndex = pdi;
          fileStartIndex = fdi;
        }
      }
    }
    const { optimizationLevel = 1 } = this.options;
    if (optimizationLevel >= 2) {
      file = this.levelTwoFileOptimize(file);
    }
    if (pattern.includes(GLOBSTAR)) {
      return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
  }
  #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
    const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
    const lastgs = pattern.lastIndexOf(GLOBSTAR);
    const [head, body, tail] = partial ? [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1),
      []
    ] : [
      pattern.slice(patternIndex, firstgs),
      pattern.slice(firstgs + 1, lastgs),
      pattern.slice(lastgs + 1)
    ];
    if (head.length) {
      const fileHead = file.slice(fileIndex, fileIndex + head.length);
      if (!this.#matchOne(fileHead, head, partial, 0, 0)) {
        return false;
      }
      fileIndex += head.length;
      patternIndex += head.length;
    }
    let fileTailMatch = 0;
    if (tail.length) {
      if (tail.length + fileIndex > file.length)
        return false;
      let tailStart = file.length - tail.length;
      if (this.#matchOne(file, tail, partial, tailStart, 0)) {
        fileTailMatch = tail.length;
      } else {
        if (file[file.length - 1] !== "" || fileIndex + tail.length === file.length) {
          return false;
        }
        tailStart--;
        if (!this.#matchOne(file, tail, partial, tailStart, 0)) {
          return false;
        }
        fileTailMatch = tail.length + 1;
      }
    }
    if (!body.length) {
      let sawSome = !!fileTailMatch;
      for (let i = fileIndex;i < file.length - fileTailMatch; i++) {
        const f = String(file[i]);
        sawSome = true;
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return partial || sawSome;
    }
    const bodySegments = [[[], 0]];
    let currentBody = bodySegments[0];
    let nonGsParts = 0;
    const nonGsPartsSums = [0];
    for (const b of body) {
      if (b === GLOBSTAR) {
        nonGsPartsSums.push(nonGsParts);
        currentBody = [[], 0];
        bodySegments.push(currentBody);
      } else {
        currentBody[0].push(b);
        nonGsParts++;
      }
    }
    let i = bodySegments.length - 1;
    const fileLength = file.length - fileTailMatch;
    for (const b of bodySegments) {
      b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
    }
    return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
  }
  #matchGlobStarBodySections(file, bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
    const bs = bodySegments[bodyIndex];
    if (!bs) {
      for (let i = fileIndex;i < file.length; i++) {
        sawTail = true;
        const f = file[i];
        if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
          return false;
        }
      }
      return sawTail;
    }
    const [body, after] = bs;
    while (fileIndex <= after) {
      const m = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
      if (m && globStarDepth < this.maxGlobstarRecursion) {
        const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
        if (sub !== false) {
          return sub;
        }
      }
      const f = file[fileIndex];
      if (f === "." || f === ".." || !this.options.dot && f.startsWith(".")) {
        return false;
      }
      fileIndex++;
    }
    return partial || null;
  }
  #matchOne(file, pattern, partial, fileIndex, patternIndex) {
    let fi;
    let pi;
    let pl;
    let fl;
    for (fi = fileIndex, pi = patternIndex, fl = file.length, pl = pattern.length;fi < fl && pi < pl; fi++, pi++) {
      this.debug("matchOne loop");
      let p = pattern[pi];
      let f = file[fi];
      this.debug(pattern, p, f);
      if (p === false || p === GLOBSTAR) {
        return false;
      }
      let hit;
      if (typeof p === "string") {
        hit = f === p;
        this.debug("string match", p, f, hit);
      } else {
        hit = p.test(f);
        this.debug("pattern match", p, f, hit);
      }
      if (!hit)
        return false;
    }
    if (fi === fl && pi === pl) {
      return true;
    } else if (fi === fl) {
      return partial;
    } else if (pi === pl) {
      return fi === fl - 1 && file[fi] === "";
    } else {
      throw new Error("wtf?");
    }
  }
  braceExpand() {
    return braceExpand(this.pattern, this.options);
  }
  parse(pattern) {
    assertValidPattern(pattern);
    const options = this.options;
    if (pattern === "**")
      return GLOBSTAR;
    if (pattern === "")
      return "";
    let m;
    let fastTest = null;
    if (m = pattern.match(starRE)) {
      fastTest = options.dot ? starTestDot : starTest;
    } else if (m = pattern.match(starDotExtRE)) {
      fastTest = (options.nocase ? options.dot ? starDotExtTestNocaseDot : starDotExtTestNocase : options.dot ? starDotExtTestDot : starDotExtTest)(m[1]);
    } else if (m = pattern.match(qmarksRE)) {
      fastTest = (options.nocase ? options.dot ? qmarksTestNocaseDot : qmarksTestNocase : options.dot ? qmarksTestDot : qmarksTest)(m);
    } else if (m = pattern.match(starDotStarRE)) {
      fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
    } else if (m = pattern.match(dotStarRE)) {
      fastTest = dotStarTest;
    }
    const re = AST.fromGlob(pattern, this.options).toMMPattern();
    if (fastTest && typeof re === "object") {
      Reflect.defineProperty(re, "test", { value: fastTest });
    }
    return re;
  }
  makeRe() {
    if (this.regexp || this.regexp === false)
      return this.regexp;
    const set = this.set;
    if (!set.length) {
      this.regexp = false;
      return this.regexp;
    }
    const options = this.options;
    const twoStar = options.noglobstar ? star2 : options.dot ? twoStarDot : twoStarNoDot;
    const flags = new Set(options.nocase ? ["i"] : []);
    let re = set.map((pattern) => {
      const pp = pattern.map((p) => {
        if (p instanceof RegExp) {
          for (const f of p.flags.split(""))
            flags.add(f);
        }
        return typeof p === "string" ? regExpEscape2(p) : p === GLOBSTAR ? GLOBSTAR : p._src;
      });
      pp.forEach((p, i) => {
        const next = pp[i + 1];
        const prev = pp[i - 1];
        if (p !== GLOBSTAR || prev === GLOBSTAR) {
          return;
        }
        if (prev === undefined) {
          if (next !== undefined && next !== GLOBSTAR) {
            pp[i + 1] = "(?:\\/|" + twoStar + "\\/)?" + next;
          } else {
            pp[i] = twoStar;
          }
        } else if (next === undefined) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + ")?";
        } else if (next !== GLOBSTAR) {
          pp[i - 1] = prev + "(?:\\/|\\/" + twoStar + "\\/)" + next;
          pp[i + 1] = GLOBSTAR;
        }
      });
      const filtered = pp.filter((p) => p !== GLOBSTAR);
      if (this.partial && filtered.length >= 1) {
        const prefixes = [];
        for (let i = 1;i <= filtered.length; i++) {
          prefixes.push(filtered.slice(0, i).join("/"));
        }
        return "(?:" + prefixes.join("|") + ")";
      }
      return filtered.join("/");
    }).join("|");
    const [open, close] = set.length > 1 ? ["(?:", ")"] : ["", ""];
    re = "^" + open + re + close + "$";
    if (this.partial) {
      re = "^(?:\\/|" + open + re.slice(1, -1) + close + ")$";
    }
    if (this.negate)
      re = "^(?!" + re + ").+$";
    try {
      this.regexp = new RegExp(re, [...flags].join(""));
    } catch {
      this.regexp = false;
    }
    return this.regexp;
  }
  slashSplit(p) {
    if (this.preserveMultipleSlashes) {
      return p.split("/");
    } else if (this.isWindows && /^\/\/[^/]+/.test(p)) {
      return ["", ...p.split(/\/+/)];
    } else {
      return p.split(/\/+/);
    }
  }
  match(f, partial = this.partial) {
    this.debug("match", f, this.pattern);
    if (this.comment) {
      return false;
    }
    if (this.empty) {
      return f === "";
    }
    if (f === "/" && partial) {
      return true;
    }
    const options = this.options;
    if (this.isWindows) {
      f = f.split("\\").join("/");
    }
    const ff = this.slashSplit(f);
    this.debug(this.pattern, "split", ff);
    const set = this.set;
    this.debug(this.pattern, "set", set);
    let filename = ff[ff.length - 1];
    if (!filename) {
      for (let i = ff.length - 2;!filename && i >= 0; i--) {
        filename = ff[i];
      }
    }
    for (const pattern of set) {
      let file = ff;
      if (options.matchBase && pattern.length === 1) {
        file = [filename];
      }
      const hit = this.matchOne(file, pattern, partial);
      if (hit) {
        if (options.flipNegate) {
          return true;
        }
        return !this.negate;
      }
    }
    if (options.flipNegate) {
      return false;
    }
    return this.negate;
  }
  static defaults(def) {
    return minimatch.defaults(def).Minimatch;
  }
}
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;

// node_modules/@actions/glob/lib/internal-path.js
import * as path3 from "path";
import assert2 from "assert";
var IS_WINDOWS3 = process.platform === "win32";

class Path {
  constructor(itemPath) {
    this.segments = [];
    if (typeof itemPath === "string") {
      assert2(itemPath, `Parameter 'itemPath' must not be empty`);
      itemPath = safeTrimTrailingSeparator(itemPath);
      if (!hasRoot(itemPath)) {
        this.segments = itemPath.split(path3.sep);
      } else {
        let remaining = itemPath;
        let dir = dirname2(remaining);
        while (dir !== remaining) {
          const basename2 = path3.basename(remaining);
          this.segments.unshift(basename2);
          remaining = dir;
          dir = dirname2(remaining);
        }
        this.segments.unshift(remaining);
      }
    } else {
      assert2(itemPath.length > 0, `Parameter 'itemPath' must not be an empty array`);
      for (let i = 0;i < itemPath.length; i++) {
        let segment = itemPath[i];
        assert2(segment, `Parameter 'itemPath' must not contain any empty segments`);
        segment = normalizeSeparators(itemPath[i]);
        if (i === 0 && hasRoot(segment)) {
          segment = safeTrimTrailingSeparator(segment);
          assert2(segment === dirname2(segment), `Parameter 'itemPath' root segment contains information for multiple segments`);
          this.segments.push(segment);
        } else {
          assert2(!segment.includes(path3.sep), `Parameter 'itemPath' contains unexpected path separators`);
          this.segments.push(segment);
        }
      }
    }
  }
  toString() {
    let result = this.segments[0];
    let skipSlash = result.endsWith(path3.sep) || IS_WINDOWS3 && /^[A-Z]:$/i.test(result);
    for (let i = 1;i < this.segments.length; i++) {
      if (skipSlash) {
        skipSlash = false;
      } else {
        result += path3.sep;
      }
      result += this.segments[i];
    }
    return result;
  }
}

// node_modules/@actions/glob/lib/internal-pattern.js
var IS_WINDOWS4 = process.platform === "win32";

class Pattern {
  constructor(patternOrNegate, isImplicitPattern = false, segments, homedir) {
    this.negate = false;
    let pattern;
    if (typeof patternOrNegate === "string") {
      pattern = patternOrNegate.trim();
    } else {
      segments = segments || [];
      assert3(segments.length, `Parameter 'segments' must not empty`);
      const root = Pattern.getLiteral(segments[0]);
      assert3(root && hasAbsoluteRoot(root), `Parameter 'segments' first element must be a root path`);
      pattern = new Path(segments).toString().trim();
      if (patternOrNegate) {
        pattern = `!${pattern}`;
      }
    }
    while (pattern.startsWith("!")) {
      this.negate = !this.negate;
      pattern = pattern.substr(1).trim();
    }
    pattern = Pattern.fixupPattern(pattern, homedir);
    this.segments = new Path(pattern).segments;
    this.trailingSeparator = normalizeSeparators(pattern).endsWith(path4.sep);
    pattern = safeTrimTrailingSeparator(pattern);
    let foundGlob = false;
    const searchSegments = this.segments.map((x) => Pattern.getLiteral(x)).filter((x) => !foundGlob && !(foundGlob = x === ""));
    this.searchPath = new Path(searchSegments).toString();
    this.rootRegExp = new RegExp(Pattern.regExpEscape(searchSegments[0]), IS_WINDOWS4 ? "i" : "");
    this.isImplicitPattern = isImplicitPattern;
    const minimatchOptions = {
      dot: true,
      nobrace: true,
      nocase: IS_WINDOWS4,
      nocomment: true,
      noext: true,
      nonegate: true
    };
    pattern = IS_WINDOWS4 ? pattern.replace(/\\/g, "/") : pattern;
    this.minimatch = new Minimatch(pattern, minimatchOptions);
  }
  match(itemPath) {
    if (this.segments[this.segments.length - 1] === "**") {
      itemPath = normalizeSeparators(itemPath);
      if (!itemPath.endsWith(path4.sep) && this.isImplicitPattern === false) {
        itemPath = `${itemPath}${path4.sep}`;
      }
    } else {
      itemPath = safeTrimTrailingSeparator(itemPath);
    }
    if (this.minimatch.match(itemPath)) {
      return this.trailingSeparator ? MatchKind.Directory : MatchKind.All;
    }
    return MatchKind.None;
  }
  partialMatch(itemPath) {
    itemPath = safeTrimTrailingSeparator(itemPath);
    if (dirname2(itemPath) === itemPath) {
      return this.rootRegExp.test(itemPath);
    }
    return this.minimatch.matchOne(itemPath.split(IS_WINDOWS4 ? /\\+/ : /\/+/), this.minimatch.set[0], true);
  }
  static globEscape(s) {
    return (IS_WINDOWS4 ? s : s.replace(/\\/g, "\\\\")).replace(/(\[)(?=[^/]+\])/g, "[[]").replace(/\?/g, "[?]").replace(/\*/g, "[*]");
  }
  static fixupPattern(pattern, homedir2) {
    assert3(pattern, "pattern cannot be empty");
    const literalSegments = new Path(pattern).segments.map((x) => Pattern.getLiteral(x));
    assert3(literalSegments.every((x, i) => (x !== "." || i === 0) && x !== ".."), `Invalid pattern '${pattern}'. Relative pathing '.' and '..' is not allowed.`);
    assert3(!hasRoot(pattern) || literalSegments[0], `Invalid pattern '${pattern}'. Root segment must not contain globs.`);
    pattern = normalizeSeparators(pattern);
    if (pattern === "." || pattern.startsWith(`.${path4.sep}`)) {
      pattern = Pattern.globEscape(process.cwd()) + pattern.substr(1);
    } else if (pattern === "~" || pattern.startsWith(`~${path4.sep}`)) {
      homedir2 = homedir2 || os.homedir();
      assert3(homedir2, "Unable to determine HOME directory");
      assert3(hasAbsoluteRoot(homedir2), `Expected HOME directory to be a rooted path. Actual '${homedir2}'`);
      pattern = Pattern.globEscape(homedir2) + pattern.substr(1);
    } else if (IS_WINDOWS4 && (pattern.match(/^[A-Z]:$/i) || pattern.match(/^[A-Z]:[^\\]/i))) {
      let root = ensureAbsoluteRoot("C:\\dummy-root", pattern.substr(0, 2));
      if (pattern.length > 2 && !root.endsWith("\\")) {
        root += "\\";
      }
      pattern = Pattern.globEscape(root) + pattern.substr(2);
    } else if (IS_WINDOWS4 && (pattern === "\\" || pattern.match(/^\\[^\\]/))) {
      let root = ensureAbsoluteRoot("C:\\dummy-root", "\\");
      if (!root.endsWith("\\")) {
        root += "\\";
      }
      pattern = Pattern.globEscape(root) + pattern.substr(1);
    } else {
      pattern = ensureAbsoluteRoot(Pattern.globEscape(process.cwd()), pattern);
    }
    return normalizeSeparators(pattern);
  }
  static getLiteral(segment) {
    let literal = "";
    for (let i = 0;i < segment.length; i++) {
      const c = segment[i];
      if (c === "\\" && !IS_WINDOWS4 && i + 1 < segment.length) {
        literal += segment[++i];
        continue;
      } else if (c === "*" || c === "?") {
        return "";
      } else if (c === "[" && i + 1 < segment.length) {
        let set = "";
        let closed = -1;
        for (let i2 = i + 1;i2 < segment.length; i2++) {
          const c2 = segment[i2];
          if (c2 === "\\" && !IS_WINDOWS4 && i2 + 1 < segment.length) {
            set += segment[++i2];
            continue;
          } else if (c2 === "]") {
            closed = i2;
            break;
          } else {
            set += c2;
          }
        }
        if (closed >= 0) {
          if (set.length > 1) {
            return "";
          }
          if (set) {
            literal += set;
            i = closed;
            continue;
          }
        }
      }
      literal += c;
    }
    return literal;
  }
  static regExpEscape(s) {
    return s.replace(/[[\\^$.|?*+()]/g, "\\$&");
  }
}

// node_modules/@actions/glob/lib/internal-search-state.js
class SearchState {
  constructor(path, level) {
    this.path = path;
    this.level = level;
  }
}

// node_modules/@actions/glob/lib/internal-globber.js
var __awaiter = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
var __asyncValues = function(o) {
  if (!Symbol.asyncIterator)
    throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i);
  function verb(n) {
    i[n] = o[n] && function(v) {
      return new Promise(function(resolve, reject) {
        v = o[n](v), settle(resolve, reject, v.done, v.value);
      });
    };
  }
  function settle(resolve, reject, d, v) {
    Promise.resolve(v).then(function(v) {
      resolve({ value: v, done: d });
    }, reject);
  }
};
var __await = function(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
};
var __asyncGenerator = function(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator)
    throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
    return this;
  }, i;
  function awaitReturn(f) {
    return function(v) {
      return Promise.resolve(v).then(f, reject);
    };
  }
  function verb(n, f) {
    if (g[n]) {
      i[n] = function(v) {
        return new Promise(function(a, b) {
          q.push([n, v, a, b]) > 1 || resume(n, v);
        });
      };
      if (f)
        i[n] = f(i[n]);
    }
  }
  function resume(n, v) {
    try {
      step(g[n](v));
    } catch (e) {
      settle(q[0][3], e);
    }
  }
  function step(r) {
    r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
  }
  function fulfill(value) {
    resume("next", value);
  }
  function reject(value) {
    resume("throw", value);
  }
  function settle(f, v) {
    if (f(v), q.shift(), q.length)
      resume(q[0][0], q[0][1]);
  }
};
var IS_WINDOWS5 = process.platform === "win32";

class DefaultGlobber {
  constructor(options) {
    this.patterns = [];
    this.searchPaths = [];
    this.options = getOptions(options);
  }
  getSearchPaths() {
    return this.searchPaths.slice();
  }
  glob() {
    return __awaiter(this, undefined, undefined, function* () {
      var _a, e_1, _b, _c;
      const result = [];
      try {
        for (var _d = true, _e = __asyncValues(this.globGenerator()), _f;_f = yield _e.next(), _a = _f.done, !_a; _d = true) {
          _c = _f.value;
          _d = false;
          const itemPath = _c;
          result.push(itemPath);
        }
      } catch (e_1_1) {
        e_1 = { error: e_1_1 };
      } finally {
        try {
          if (!_d && !_a && (_b = _e.return))
            yield _b.call(_e);
        } finally {
          if (e_1)
            throw e_1.error;
        }
      }
      return result;
    });
  }
  globGenerator() {
    return __asyncGenerator(this, arguments, function* globGenerator_1() {
      const options = getOptions(this.options);
      const patterns = [];
      for (const pattern of this.patterns) {
        patterns.push(pattern);
        if (options.implicitDescendants && (pattern.trailingSeparator || pattern.segments[pattern.segments.length - 1] !== "**")) {
          patterns.push(new Pattern(pattern.negate, true, pattern.segments.concat("**")));
        }
      }
      const stack = [];
      for (const searchPath of getSearchPaths(patterns)) {
        debug(`Search path '${searchPath}'`);
        try {
          yield __await(fs.promises.lstat(searchPath));
        } catch (err) {
          if (err.code === "ENOENT") {
            continue;
          }
          throw err;
        }
        stack.unshift(new SearchState(searchPath, 1));
      }
      const traversalChain = [];
      while (stack.length) {
        const item = stack.pop();
        const match2 = match(patterns, item.path);
        const partialMatch2 = !!match2 || partialMatch(patterns, item.path);
        if (!match2 && !partialMatch2) {
          continue;
        }
        const stats = yield __await(DefaultGlobber.stat(item, options, traversalChain));
        if (!stats) {
          continue;
        }
        if (options.excludeHiddenFiles && path5.basename(item.path).match(/^\./)) {
          continue;
        }
        if (stats.isDirectory()) {
          if (match2 & MatchKind.Directory && options.matchDirectories) {
            yield yield __await(item.path);
          } else if (!partialMatch2) {
            continue;
          }
          const childLevel = item.level + 1;
          const childItems = (yield __await(fs.promises.readdir(item.path))).map((x) => new SearchState(path5.join(item.path, x), childLevel));
          stack.push(...childItems.reverse());
        } else if (match2 & MatchKind.File) {
          yield yield __await(item.path);
        }
      }
    });
  }
  static create(patterns, options) {
    return __awaiter(this, undefined, undefined, function* () {
      const result = new DefaultGlobber(options);
      if (IS_WINDOWS5) {
        patterns = patterns.replace(/\r\n/g, `
`);
        patterns = patterns.replace(/\r/g, `
`);
      }
      const lines = patterns.split(`
`).map((x) => x.trim());
      for (const line of lines) {
        if (!line || line.startsWith("#")) {
          continue;
        } else {
          result.patterns.push(new Pattern(line));
        }
      }
      result.searchPaths.push(...getSearchPaths(result.patterns));
      return result;
    });
  }
  static stat(item, options, traversalChain) {
    return __awaiter(this, undefined, undefined, function* () {
      let stats;
      if (options.followSymbolicLinks) {
        try {
          stats = yield fs.promises.stat(item.path);
        } catch (err) {
          if (err.code === "ENOENT") {
            if (options.omitBrokenSymbolicLinks) {
              debug(`Broken symlink '${item.path}'`);
              return;
            }
            throw new Error(`No information found for the path '${item.path}'. This may indicate a broken symbolic link.`);
          }
          throw err;
        }
      } else {
        stats = yield fs.promises.lstat(item.path);
      }
      if (stats.isDirectory() && options.followSymbolicLinks) {
        const realPath = yield fs.promises.realpath(item.path);
        while (traversalChain.length >= item.level) {
          traversalChain.pop();
        }
        if (traversalChain.some((x) => x === realPath)) {
          debug(`Symlink cycle detected for path '${item.path}' and realpath '${realPath}'`);
          return;
        }
        traversalChain.push(realPath);
      }
      return stats;
    });
  }
}

// node_modules/@actions/glob/lib/glob.js
var __awaiter2 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
function create(patterns, options) {
  return __awaiter2(this, undefined, undefined, function* () {
    return yield DefaultGlobber.create(patterns, options);
  });
}

// src/readers/index.ts
import { readdir, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { basename as basename3, dirname as dirname3, join as join2 } from "node:path";

// src/readers/allure.ts
var STATUS = {
  passed: "passed",
  failed: "failed",
  broken: "errored",
  skipped: "skipped",
  unknown: "other"
};
function isAllureResult(json) {
  if (!json || typeof json !== "object")
    return false;
  const r = json;
  return typeof r.status === "string" && (typeof r.historyId === "string" || typeof r.fullName === "string" || typeof r.uuid === "string");
}
function readAllure(results) {
  const groups = new Map;
  for (const raw of results) {
    if (!raw || typeof raw !== "object")
      continue;
    const r = raw;
    const key = r.historyId ?? r.testCaseId ?? r.fullName ?? r.name;
    if (!key)
      continue;
    const g = groups.get(key);
    if (g)
      g.push(r);
    else
      groups.set(key, [r]);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.stop ?? a.start ?? 0) - (b.stop ?? b.start ?? 0));
    const r = group[group.length - 1];
    const status = STATUS[(r.status ?? "").toLowerCase()] ?? "other";
    const labels = new Map;
    for (const l of r.labels ?? [])
      if (l.name && l.value && !labels.has(l.name))
        labels.set(l.name, l.value);
    const suiteParts = ["parentSuite", "suite", "subSuite"].map((n) => labels.get(n)).filter((x) => !!x);
    if (!suiteParts.length) {
      const cls = labels.get("testClass") ?? labels.get("package");
      if (cls)
        suiteParts.push(cls);
    }
    const params = (r.parameters ?? []).filter((p) => !p.excluded && p.name).map((p) => `${p.name}=${p.value ?? ""}`);
    const baseName = r.name ?? r.fullName ?? "(unnamed)";
    const name = params.length ? `${baseName} [${params.join(", ")}]` : baseName;
    const suite = suiteParts.join(" › ");
    const durationMs = r.start !== undefined && r.stop !== undefined && r.stop >= r.start ? r.stop - r.start : 0;
    const tc = {
      id: testId(suite, name),
      suite,
      name,
      status,
      durationMs
    };
    if (status !== "passed") {
      const message = truncate([r.statusDetails?.message, r.statusDetails?.trace].filter(Boolean).join(`
`));
      if (message)
        tc.message = message;
    } else if (r.statusDetails?.flaky || group.slice(0, -1).some((x) => x.status !== "passed" && x.status !== "skipped")) {
      tc.flaky = true;
    }
    out.push(tc);
  }
  return out;
}

// src/readers/ctrf.ts
function isCtrf(json) {
  if (!json || typeof json !== "object")
    return false;
  const results = json.results;
  return !!results && Array.isArray(results.tests);
}
var STATUS2 = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  pending: "skipped",
  other: "other"
};
function readCtrf(json, workspace) {
  if (!isCtrf(json))
    throw new Error("Not a CTRF report (no results.tests array)");
  const tests = json.results.tests;
  return tests.map((t) => {
    const name = typeof t.name === "string" && t.name ? t.name : "(unnamed)";
    const suite = Array.isArray(t.suite) ? t.suite.map(String).join(" › ") : typeof t.suite === "string" ? t.suite.split(/\s*>\s*/).join(" › ") : "";
    const status = STATUS2[String(t.status).toLowerCase()] ?? "other";
    const duration = Number(t.duration);
    const out = {
      id: testId(suite, name),
      suite,
      name,
      status,
      durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0
    };
    if (typeof t.filePath === "string" && t.filePath)
      out.file = relativize(t.filePath, workspace);
    if (status !== "passed") {
      const message = truncate([t.message, t.trace].filter((x) => typeof x === "string" && x).join(`
`));
      if (message)
        out.message = message;
    }
    if (status === "passed" && t.flaky === true)
      out.flaky = true;
    return out;
  });
}

// src/readers/junit.ts
var ARRAYS = [
  "testsuite",
  "testcase",
  "failure",
  "error",
  "skipped",
  "flakyFailure",
  "flakyError",
  "rerunFailure",
  "rerunError"
];
var GENERIC_SUITES = new Set(["root suite", "mocha tests", "bun test", ""]);
function isJunit(xml) {
  const m = /<(?!\?|!)([A-Za-z_][\w:.-]*)/.exec(xml);
  return m?.[1] === "testsuites" || m?.[1] === "testsuite";
}
function readJunit(xml, workspace) {
  const doc = parseXml(xml, ARRAYS);
  const out = [];
  const roots = doc.testsuites ? children(doc, "testsuites").flatMap((r) => children(r, "testsuite")) : children(doc, "testsuite");
  for (const r of children(doc, "testsuites"))
    for (const tc of children(r, "testcase"))
      out.push(toCase(tc, [], undefined, workspace));
  const walk = (suite, path, inheritedFile) => {
    const file = attr(suite, "file") ?? attr(suite, "filepath") ?? inheritedFile;
    let name = attr(suite, "name") ?? "";
    if (file && name === file)
      name = relativize(file, workspace);
    const here = GENERIC_SUITES.has(name.toLowerCase()) ? path : [...path, name];
    for (const tc of children(suite, "testcase"))
      out.push(toCase(tc, here, file, workspace));
    for (const s of children(suite, "testsuite"))
      walk(s, here, file);
  };
  for (const s of roots)
    walk(s, []);
  return out;
}
function toCase(tc, path, suiteFile, workspace) {
  const name = attr(tc, "name") ?? "(unnamed)";
  const classname = attr(tc, "classname") ?? "";
  const segs = [...path];
  if (classname && segs[segs.length - 1] !== classname)
    segs.push(classname);
  const suite = segs.join(" › ");
  const rawFile = attr(tc, "file") ?? suiteFile;
  const file = rawFile ? relativize(rawFile, workspace) : undefined;
  const failures = children(tc, "failure");
  const errors = children(tc, "error");
  const skipped = children(tc, "skipped");
  const flakes = [
    ...children(tc, "flakyFailure"),
    ...children(tc, "flakyError")
  ];
  const status = statusOf(tc, failures.length, errors.length, skipped.length);
  const problem = errors[0] ?? failures[0] ?? (status === "skipped" ? skipped[0] : undefined);
  const message = status === "passed" ? undefined : truncate([attr(problem, "message"), text(problem)].filter(Boolean).join(`
`));
  const out = {
    id: testId(suite, name),
    suite,
    name,
    status,
    durationMs: secondsToMs(attr(tc, "time"))
  };
  if (file)
    out.file = file;
  if (message)
    out.message = message;
  if (status === "passed" && flakes.length)
    out.flaky = true;
  return out;
}
function statusOf(tc, failures, errors, skipped) {
  if (errors)
    return "errored";
  if (failures)
    return "failed";
  if (skipped)
    return "skipped";
  const s = (attr(tc, "status") ?? "").toLowerCase();
  const result = (attr(tc, "result") ?? "").toLowerCase();
  if (["notrun", "disabled", "skipped", "ignored"].includes(s))
    return "skipped";
  if (["suppressed", "skipped"].includes(result))
    return "skipped";
  if (["fail", "failed", "failure"].includes(s))
    return "failed";
  if (s === "error")
    return "errored";
  return "passed";
}

// src/readers/index.ts
var TEST_FORMATS = TEST_FORMAT_LIST;
var MAX_BYTES2 = 256 * 1024 * 1024;
async function readText(path) {
  const s = await stat2(path);
  if (s.size > MAX_BYTES2)
    throw new Error(`${path} is ${s.size} bytes; refusing to parse more than ${MAX_BYTES2}`);
  return (await readFile2(path, "utf8")).replace(/^﻿/, "");
}
var isAllureFile = (f) => f.endsWith("-result.json");
async function readAllureDir(dir, files) {
  const names = files ?? (await readdir(dir)).filter(isAllureFile);
  const results = [];
  for (const n of names) {
    try {
      results.push(JSON.parse(await readText(join2(dir, n))));
    } catch (err) {
      throw new Error(`${join2(dir, n)}: ${err.message}`);
    }
  }
  return { format: "allure", path: dir, tests: readAllure(results) };
}
async function readTestPaths(paths, workspace, forced) {
  const out = [];
  const allureFiles = new Map;
  for (const p of paths) {
    const s = await stat2(p);
    if (s.isDirectory()) {
      if (forced && forced !== "allure")
        throw new Error(`${p} is a directory; only Allure results are read from directories`);
      const names = (await readdir(p)).filter(isAllureFile);
      if (names.length)
        allureFiles.set(p, names);
      continue;
    }
    if (forced === "allure" || !forced && isAllureFile(p)) {
      const dir = dirname3(p);
      const list = allureFiles.get(dir) ?? [];
      if (!list.includes(basename3(p)))
        list.push(basename3(p));
      allureFiles.set(dir, list);
      continue;
    }
    const body = await readText(p);
    const trimmed = body.trimStart();
    if (forced === "junit" || !forced && trimmed.startsWith("<")) {
      if (!forced && !isJunit(trimmed))
        throw new Error(`${p}: XML, but the root isn't <testsuites>/<testsuite>`);
      out.push({ format: "junit", path: p, tests: readJunit(body, workspace) });
      continue;
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`${p}: not XML or JSON; can't detect the test format`);
    }
    if (forced === "ctrf" || isCtrf(json)) {
      out.push({ format: "ctrf", path: p, tests: readCtrf(json, workspace) });
      continue;
    }
    if (isAllureResult(json)) {
      const dir = dirname3(p);
      allureFiles.set(dir, [...allureFiles.get(dir) ?? [], basename3(p)]);
      continue;
    }
    throw new Error(`${p}: JSON, but not CTRF or an Allure result`);
  }
  for (const [dir, files] of allureFiles)
    out.push(await readAllureDir(dir, files));
  return out;
}

// src/collect/gather.ts
function parseMatrix(raw) {
  const s = raw.trim();
  if (!s || s === "null")
    return {};
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    throw new Error(`matrix input isn't JSON: ${s.slice(0, 200)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return {};
  const out = {};
  for (const [k, val] of Object.entries(v))
    out[k] = typeof val === "string" ? val : JSON.stringify(val);
  return out;
}
function identity(job, matrix, id, runnerOs) {
  const keys = Object.keys(matrix).sort();
  const canonical = JSON.stringify([job, keys.map((k) => [k, matrix[k]]), id]);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const values = keys.map((k) => matrix[k]);
  const parts = [...values, ...id ? [id] : []];
  const label = parts.length ? `${job} (${parts.join(", ")})` : job;
  const dims = { ...matrix };
  if (runnerOs)
    dims["runner.os"] = runnerOs;
  return { key, label, job, dims };
}
function parseList(raw) {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
function parseFormat(raw) {
  const v = raw.trim().toLowerCase();
  if (!v || v === "auto")
    return;
  if (TEST_FORMATS.includes(v))
    return v;
  throw new Error(`Unknown test format ${JSON.stringify(raw)} (expected auto, ${TEST_FORMATS.join(", ")})`);
}
async function expand2(patterns) {
  if (!patterns.length)
    return [];
  const g = await create(patterns.join(`
`), {
    matchDirectories: true,
    implicitDescendants: false,
    followSymbolicLinks: false
  });
  return [...new Set(await g.glob())].sort();
}
async function gather(o) {
  const paths = await expand2(o.testPatterns);
  const results = await readTestPaths(paths, o.workspace, o.testFormat);
  const covPaths = await expand2(o.coveragePatterns ?? []);
  const cov = covPaths.length ? await readCoveragePaths(covPaths, o.workspace, o.coverageFormat) : undefined;
  for (const w of cov?.warnings ?? [])
    o.warn?.(w);
  const upload = {
    schema: SCHEMA,
    key: o.identity.key,
    label: o.identity.label,
    job: o.identity.job,
    dims: o.identity.dims,
    flags: [...new Set(o.flags)].sort(),
    attempt: o.attempt,
    createdAt: (o.now ?? new Date).toISOString(),
    sources: results.map((r) => ({
      format: r.format,
      path: toPosix(relative2(o.workspace, r.path)) || ".",
      tests: r.tests.length
    })),
    tests: results.flatMap((r) => r.tests)
  };
  if (cov?.sources.length)
    upload.coverage = {
      sources: cov.sources,
      files: encodeCoverage(cov.coverage)
    };
  return upload;
}

// src/context.ts
import { readFileSync } from "node:fs";
function readEvent(path) {
  if (!path)
    return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
function readContext(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo)
    throw new Error("GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.");
  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  const event = env.GITHUB_EVENT_NAME || "unknown";
  const payload = readEvent(env.GITHUB_EVENT_PATH);
  const runId = Number(env.GITHUB_RUN_ID || 0);
  const pr = payload.pull_request;
  const run = {
    id: runId,
    attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    number: Number(env.GITHUB_RUN_NUMBER || 0),
    workflow: env.GITHUB_WORKFLOW || "",
    url: `${serverUrl}/${repo}/actions/runs/${runId}`
  };
  const ref = env.GITHUB_REF || "";
  const commit = {
    sha: pr?.head?.sha || env.GITHUB_SHA || "",
    ref,
    event
  };
  const branch = pr ? env.GITHUB_HEAD_REF || pr.head?.ref : ref.startsWith("refs/heads/") ? ref.slice(11) : undefined;
  if (branch)
    commit.branch = branch;
  if (pr?.number)
    commit.pr = Number(pr.number);
  const ctx = {
    repo,
    serverUrl,
    run,
    commit,
    fromFork: !!pr && pr.head?.repo?.full_name !== undefined && pr.head.repo.full_name !== repo,
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
    job: env.GITHUB_JOB || "job"
  };
  const defaultBranch = payload.repository?.default_branch;
  if (defaultBranch)
    ctx.defaultBranch = defaultBranch;
  const base = env.GITHUB_BASE_REF || pr?.base?.ref;
  if (base)
    ctx.baseBranch = base;
  if (env.RUNNER_OS)
    ctx.runnerOs = env.RUNNER_OS;
  const patchBase = pr ? pr.base?.sha : event === "push" ? payload.before : undefined;
  if (patchBase && /^[0-9a-f]{7,64}$/i.test(patchBase) && !/^0+$/.test(patchBase))
    ctx.patchBase = patchBase;
  return ctx;
}
function parseRecordMode(raw) {
  const v = raw.trim().toLowerCase();
  if (!v || v === "auto")
    return "auto";
  if (v === "always" || v === "true")
    return "always";
  if (v === "never" || v === "false")
    return "never";
  throw new Error(`Invalid record: ${JSON.stringify(raw)} (expected auto, always or never)`);
}
var RECORDED_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);
function shouldRecord(mode, ctx) {
  if (mode !== "auto")
    return mode === "always";
  if (!RECORDED_EVENTS.has(ctx.commit.event))
    return false;
  return !!ctx.defaultBranch && ctx.commit.branch === ctx.defaultBranch;
}

// src/upload.ts
import {
  mkdir,
  mkdtemp,
  readFile as readFile3,
  readdir as readdir2,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var DEFAULT_PREFIX = "standalone-stats-";
var REPORT_ARTIFACT = "standalone-stats-report";
var FILE = "upload.json";
var MAX_TESTS = 200000;
var MAX_STR = 1000;
var str = (v, max = MAX_STR) => typeof v === "string" ? v.slice(0, max) : "";
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
function validateUpload(raw) {
  if (!raw || typeof raw !== "object")
    throw new Error("upload is not an object");
  const u = raw;
  if (u.schema !== SCHEMA)
    throw new Error(`unsupported upload schema ${String(u.schema)} (expected ${SCHEMA})`);
  const key = str(u.key, 64);
  if (!/^[0-9a-f]{8,64}$/.test(key))
    throw new Error("upload key is missing or malformed");
  const tests = Array.isArray(u.tests) ? u.tests : [];
  if (tests.length > MAX_TESTS)
    throw new Error(`upload has ${tests.length} tests (max ${MAX_TESTS})`);
  const dims = {};
  if (u.dims && typeof u.dims === "object")
    for (const [k, v] of Object.entries(u.dims).slice(0, 50))
      dims[k.slice(0, 100)] = str(v, 200);
  const out = {
    schema: SCHEMA,
    key,
    label: str(u.label, 300) || key,
    job: str(u.job, 200),
    dims,
    flags: (Array.isArray(u.flags) ? u.flags : []).map((f) => str(f, 100)).filter(Boolean).slice(0, 50),
    attempt: Math.max(1, Math.floor(num(u.attempt))),
    createdAt: str(u.createdAt, 40),
    sources: (Array.isArray(u.sources) ? u.sources : []).slice(0, 1000).map((s) => {
      const o = s ?? {};
      const format = TEST_FORMAT_LIST.find((f) => f === o.format) ?? "junit";
      return { format, path: str(o.path), tests: Math.floor(num(o.tests)) };
    }),
    tests: tests.map(validateTest)
  };
  const cov = u.coverage;
  if (cov && typeof cov === "object") {
    const files = encodeCoverage(decodeCoverage(cov.files));
    const sources = (Array.isArray(cov.sources) ? cov.sources : []).slice(0, 1000).map((s) => {
      const o = s ?? {};
      return {
        format: COVERAGE_FORMAT_LIST.find((f) => f === o.format) ?? "lcov",
        path: str(o.path),
        files: Math.floor(num(o.files)),
        external: Math.floor(num(o.external))
      };
    });
    if (sources.length || files.length)
      out.coverage = { sources, files };
  }
  return out;
}
function validateTest(raw) {
  const t = raw ?? {};
  const status = Object.keys(STATUS_SEVERITY).find((s) => s === t.status) ?? "other";
  const suite = str(t.suite);
  const name = str(t.name) || "(unnamed)";
  const out = {
    id: str(t.id, 2 * MAX_STR + 3) || (suite ? `${suite} › ${name}` : name),
    suite,
    name,
    status,
    durationMs: Math.round(num(t.durationMs))
  };
  const file = str(t.file);
  if (file)
    out.file = file;
  const message = truncate(str(t.message, 4 * MAX_STR));
  if (message && status !== "passed")
    out.message = message;
  if (t.flaky === true && status === "passed")
    out.flaky = true;
  return out;
}
function artifactName(prefix, key) {
  return `${prefix}${key}`;
}
async function uploadArtifact(upload, prefix, retentionDays) {
  const dir = await mkdtemp(join3(process.env.RUNNER_TEMP || tmpdir(), "standalone-stats-collect-"));
  try {
    const file = join3(dir, FILE);
    await writeFile(file, JSON.stringify(upload));
    const name = artifactName(prefix, upload.key);
    const client = new DefaultArtifactClient;
    await client.uploadArtifact(name, [file], dir, { retentionDays });
    return name;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
async function downloadUploads(prefix) {
  const client = new DefaultArtifactClient;
  const { artifacts } = await client.listArtifacts({ latest: true });
  const mine = artifacts.filter((a) => a.name.startsWith(prefix) && a.name !== REPORT_ARTIFACT);
  const root = await mkdtemp(join3(process.env.RUNNER_TEMP || tmpdir(), "standalone-stats-dl-"));
  const uploads = [];
  try {
    for (const a of mine) {
      const path = join3(root, String(a.id));
      await mkdir(path, { recursive: true });
      await client.downloadArtifact(a.id, { path });
      const files = await readdir2(path);
      if (!files.includes(FILE)) {
        warning(`Artifact ${a.name} has no ${FILE}; skipping`);
        continue;
      }
      try {
        uploads.push(validateUpload(JSON.parse(await readFile3(join3(path, FILE), "utf8"))));
      } catch (err) {
        warning(`Artifact ${a.name}: ${err.message}; skipping`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return dedupe(uploads);
}
function dedupe(uploads) {
  const best = new Map;
  for (const u of uploads) {
    const cur = best.get(u.key);
    if (!cur || u.attempt > cur.attempt || u.attempt === cur.attempt && u.createdAt > cur.createdAt)
      best.set(u.key, u);
  }
  return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export { parseCoverageFormat, parseMatrix, identity, parseList, parseFormat, gather, readContext, parseRecordMode, shouldRecord, DEFAULT_PREFIX, uploadArtifact, downloadUploads, dedupe };
