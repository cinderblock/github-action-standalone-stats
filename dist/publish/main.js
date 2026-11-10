import {
  summary,
  setSecret,
  getInput,
  setOutput,
  setFailed,
  debug,
  warning,
  info,
  SCHEMA,
  STATUS_SEVERITY,
  STATUS_CODE,
  emptyTotals,
  addTest,
  sumTotals,
  worse,
  mergeCoverage,
  totals,
  pct,
  formatPct,
  encodeCoverage,
  decodeCoverage,
  parseCoverageFormat,
  parseMatrix,
  identity,
  parseList,
  parseFormat,
  gather,
  readContext,
  parseRecordMode,
  shouldRecord,
  DEFAULT_PREFIX,
  downloadUploads,
  dedupe
} from "../chunks/main-g8cm915c.js";

// src/publish/main.ts
import { cp as cp2, mkdir as mkdir2, rm as rm3, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/git.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class GitError extends Error {
  stderr;
  code;
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}
function gitEnv(remote) {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (remote.token && /^https?:\/\//.test(remote.url)) {
    const origin = new URL(remote.url).origin;
    const basic = Buffer.from(`x-access-token:${remote.token}`).toString("base64");
    let n = Number.parseInt(e.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    const add = (key, value) => {
      e[`GIT_CONFIG_KEY_${n}`] = key;
      e[`GIT_CONFIG_VALUE_${n}`] = value;
      n++;
    };
    add("http.extraheader", "");
    add(`http.${origin}/.extraheader`, "");
    add(`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${basic}`);
    e.GIT_CONFIG_COUNT = String(n);
  }
  return e;
}
function git(remote, args, cwd) {
  debug(`git ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: cwd ?? tmpdir(),
      env: gitEnv(remote),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === "number" ? err.code : null;
        reject(new GitError(`git ${args[0]} failed (exit ${code ?? "?"}): ${stderr.trim() || err.message}`, stderr, code));
      } else
        resolve({ stdout, stderr });
    });
  });
}
async function remoteHasBranch(remote, branch) {
  const { stdout } = await git(remote, [
    "ls-remote",
    "--heads",
    "--",
    remote.url,
    `refs/heads/${branch}`
  ]);
  return stdout.trim().length > 0;
}
async function checkout(remote, branch) {
  const dir = await mkdtemp(join(tmpdir(), "standalone-stats-"));
  if (await remoteHasBranch(remote, branch)) {
    await git(remote, [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      branch,
      "--",
      remote.url,
      dir
    ]);
    return { dir, fresh: false };
  }
  await git(remote, ["init", "--quiet", `--initial-branch=${branch}`], dir);
  await git(remote, ["remote", "add", "origin", remote.url], dir);
  return { dir, fresh: true };
}
async function commitAll(remote, dir, message, author) {
  await git(remote, ["add", "--all", "."], dir);
  try {
    await git(remote, ["diff", "--cached", "--quiet"], dir);
    return false;
  } catch (err) {
    if (!(err instanceof GitError) || err.code !== 1)
      throw err;
  }
  await git(remote, [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    message
  ], dir);
  return true;
}
function isRaceRejection(err) {
  if (!(err instanceof GitError))
    return false;
  return /\[rejected\]|non-fast-forward|fetch first|cannot lock ref|incorrect old value|stale info/i.test(err.stderr);
}
async function publishBranch(opts) {
  const attempts = opts.attempts ?? 6;
  const base = opts.backoffMs ?? 1000;
  for (let i = 1;; i++) {
    const { dir, fresh } = await checkout(opts.remote, opts.branch);
    let keep = false;
    try {
      await opts.apply(dir, fresh);
      if (!await commitAll(opts.remote, dir, opts.message, opts.author)) {
        keep = true;
        return { committed: false, attempts: i, dir };
      }
      try {
        await git(opts.remote, ["push", "--quiet", "origin", `HEAD:refs/heads/${opts.branch}`], dir);
        keep = true;
        return { committed: true, attempts: i, dir };
      } catch (err) {
        if (!isRaceRejection(err) || i >= attempts)
          throw err;
        const wait = base * 2 ** (i - 1) * (0.5 + Math.random());
        info(`Push to ${opts.branch} lost a race (attempt ${i}/${attempts}); retrying in ${Math.round(wait)} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      if (!keep)
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// src/coverage/patch.ts
function addedLines(patch) {
  const out = new Set;
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split(`
`)) {
    const l = raw.replace(/\r$/, "");
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk)
      continue;
    if (l.startsWith("+"))
      out.add(line++);
    else if (l.startsWith("-"))
      continue;
    else if (l.startsWith("\\"))
      continue;
    else
      line++;
  }
  return out;
}
function patchCoverage(cov, diff, base) {
  const files = [];
  let hit = 0;
  let total = 0;
  for (const [path, lines] of diff.files) {
    const file = cov.get(path);
    if (!file)
      continue;
    let fh = 0;
    let ft = 0;
    for (const n of lines) {
      const c = file.get(n);
      if (!c || c.hits < 0)
        continue;
      ft++;
      if (c.hits > 0)
        fh++;
    }
    if (!ft)
      continue;
    files.push({ path, hit: fh, total: ft });
    hit += fh;
    total += ft;
  }
  files.sort((a, b) => a.hit / a.total - b.hit / b.total || a.path.localeCompare(b.path));
  return { base, partial: diff.partial, hit, total, files };
}

// src/github.ts
function parseRepo(slug) {
  const m = slug.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m)
    throw new Error(`Invalid repo slug: ${JSON.stringify(slug)} (expected "owner/name")`);
  return { owner: m[1], name: m[2] };
}
async function api(method, path, body, {
  token,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com"
}) {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  debug(`${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-action-standalone-stats",
      ...body === undefined ? {} : { "Content-Type": "application/json" }
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}
async function getRepo(ref, opts) {
  const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}`, undefined, opts);
  if (status === 404)
    return;
  if (status !== 200)
    throw new Error(`Unexpected status ${status} reading ${ref.owner}/${ref.name}`);
  return {
    private: !!body.private,
    defaultBranch: body.default_branch ?? "main"
  };
}
async function getPages(ref, opts) {
  const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}/pages`, undefined, opts);
  if (status === 404)
    return { state: "none" };
  if (status !== 200)
    return { state: "unknown", status };
  const info = { state: "enabled", public: body.public !== false };
  if (body.build_type)
    info.buildType = body.build_type;
  if (body.source)
    info.source = body.source;
  if (body.html_url)
    info.url = body.html_url;
  return info;
}
async function isOrg(owner, opts) {
  const { status, body } = await api("GET", `/users/${owner}`, undefined, opts);
  if (status !== 200)
    throw new Error(`Failed to look up ${owner}: status ${status}`);
  return body.type === "Organization";
}
async function createRepo(ref, opts) {
  const org = await isOrg(ref.owner, opts);
  const { status, body } = await api("POST", org ? `/orgs/${ref.owner}/repos` : "/user/repos", {
    name: ref.name,
    description: "Test and coverage stats, published by github-action-standalone-stats",
    private: opts.visibility === "private",
    auto_init: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false
  }, opts);
  if (status >= 200 && status < 300)
    return;
  throw new Error(`Failed to create ${ref.owner}/${ref.name}: status ${status} ${body?.message ?? ""}`.trim());
}
async function enablePages(ref, branch, opts) {
  const { status } = await api("POST", `/repos/${ref.owner}/${ref.name}/pages`, { source: { branch, path: "/" } }, opts);
  if (status === 201 || status === 204 || status === 409)
    return;
  warning(`Could not enable Pages on ${ref.owner}/${ref.name} (status ${status}). Enable it in Settings → Pages, source: branch ${branch}.`);
}
function defaultPagesUrl(ref, path) {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const suffix = trimmed ? `${trimmed}/` : "";
  if (ref.name.toLowerCase() === `${ref.owner.toLowerCase()}.github.io`)
    return `https://${ref.name}/${suffix}`;
  return `https://${ref.owner}.github.io/${ref.name}/${suffix}`;
}
var COMPARE_FILE_CAP = 300;
async function compareDiff(ref, base, head, opts) {
  const files = new Map;
  let partial = false;
  let seen = 0;
  for (let page = 1;page <= 3; page++) {
    const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`, undefined, opts);
    if (status !== 200) {
      if (page === 1) {
        info(`No diff for patch coverage (compare API status ${status})`);
        return;
      }
      partial = true;
      break;
    }
    const list = body.files ?? [];
    for (const f of list) {
      seen++;
      if (f.status === "removed")
        continue;
      if (f.patch === undefined) {
        if (f.changes)
          partial = true;
        continue;
      }
      files.set(f.filename, addedLines(f.patch));
    }
    if (list.length < 100)
      break;
    if (seen >= COMPARE_FILE_CAP)
      partial = true;
  }
  return { files, partial };
}

// src/coverage/components.ts
function globToRegExp(glob) {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const anywhere = !g.includes("/");
  if (g.startsWith("/"))
    g = g.slice(1);
  let re = "";
  let depth = 0;
  for (let i = 0;i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else
        re += "[^/]*";
    } else if (c === "?")
      re += "[^/]";
    else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth) {
      depth--;
      re += ")";
    } else if (c === "," && depth)
      re += "|";
    else
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  if (g.endsWith("/"))
    re += ".*";
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${re}$`);
}
function parseComponents(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#"))
      continue;
    const i = s.indexOf(":");
    if (i <= 0)
      throw new Error(`components: expected "Name: glob, glob", got ${JSON.stringify(s)}`);
    const name = s.slice(0, i).trim();
    const patterns = s.slice(i + 1).split(",").map((p) => p.trim()).filter(Boolean);
    if (!patterns.length)
      throw new Error(`components: ${JSON.stringify(name)} has no globs`);
    const existing = out.find((c) => c.name === name);
    if (existing)
      existing.patterns.push(...patterns);
    else
      out.push({ name, patterns });
  }
  return out;
}
var LANGUAGES = [
  ["TypeScript", ["ts", "tsx", "mts", "cts"]],
  ["JavaScript", ["js", "jsx", "mjs", "cjs"]],
  ["C/C++", ["c", "h", "cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h++", "ipp", "inl"]],
  ["Objective-C", ["m", "mm"]],
  ["Python", ["py", "pyx"]],
  ["Go", ["go"]],
  ["Rust", ["rs"]],
  ["Java", ["java"]],
  ["Kotlin", ["kt", "kts"]],
  ["Scala", ["scala"]],
  ["C#", ["cs"]],
  ["F#", ["fs"]],
  ["Swift", ["swift"]],
  ["Ruby", ["rb"]],
  ["PHP", ["php"]],
  ["Dart", ["dart"]],
  ["Elixir", ["ex", "exs"]],
  ["Vue", ["vue"]],
  ["Svelte", ["svelte"]]
];
var BY_EXT = new Map(LANGUAGES.flatMap(([lang, exts]) => exts.map((e) => [e, lang])));
function languageOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0)
    return "Other";
  return BY_EXT.get(base.slice(dot + 1).toLowerCase()) ?? "Other";
}
function assignComponents(paths, components) {
  const out = new Map;
  if (!components.length) {
    for (const p of paths)
      out.set(p, [languageOf(p)]);
    return out;
  }
  const compiled = components.map((c) => ({
    name: c.name,
    res: c.patterns.map(globToRegExp)
  }));
  for (const p of paths)
    out.set(p, compiled.filter((c) => c.res.some((r) => r.test(p))).map((c) => c.name));
  return out;
}

// src/publish/coverage.ts
var PATCH_FILE_CAP = 100;
function detailPath(key) {
  return `data/detail/${key}.json`;
}
var groupKey = (flags) => JSON.stringify([...flags].sort());
function addGroup(groups, flags, cov) {
  const k = groupKey(flags);
  const g = groups.get(k);
  if (g)
    mergeCoverage(g.cov, cov);
  else
    groups.set(k, { flags: [...flags].sort(), cov: mergeCoverage(new Map, cov) });
}
function buildCoverage(uploads, o) {
  const groups = new Map;
  const perUpload = new Map;
  const present = new Set;
  for (const u of uploads) {
    if (!u.coverage)
      continue;
    const cov = decodeCoverage(u.coverage.files);
    perUpload.set(u.key, totals(cov));
    for (const f of u.flags)
      present.add(f);
    addGroup(groups, u.flags, cov);
  }
  const carried = new Set;
  for (const g of o.baselineDetail?.groups ?? []) {
    const flags = Array.isArray(g.flags) ? g.flags.map(String) : [];
    if (!flags.length)
      continue;
    if (!flags.every((f) => !present.has(f) && o.carryforward(f)))
      continue;
    for (const f of flags)
      carried.add(f);
    addGroup(groups, flags, decodeCoverage(g.files));
  }
  if (!groups.size)
    return;
  const merged = new Map;
  for (const g of groups.values())
    mergeCoverage(merged, g.cov);
  const allFlags = [...new Set([...groups.values()].flatMap((g) => g.flags))].sort();
  const flags = {};
  for (const f of allFlags) {
    const cov = new Map;
    for (const g of groups.values())
      if (g.flags.includes(f))
        mergeCoverage(cov, g.cov);
    flags[f] = carried.has(f) ? { ...totals(cov), carried: true } : totals(cov);
  }
  const assignment = assignComponents(merged.keys(), o.components);
  const names = [...new Set([...assignment.values()].flat())].sort();
  const components = {};
  for (const name of names)
    components[name] = totals(merged, (p) => assignment.get(p)?.includes(name) ?? false);
  const detail = detailPath(o.key);
  const coverage = {
    totals: totals(merged),
    flags,
    components,
    carriedForward: [...carried].sort(),
    detail
  };
  if (o.diff) {
    const p = patchCoverage(merged, o.diff.diff, o.diff.base);
    coverage.patch = { ...p, files: p.files.slice(0, PATCH_FILE_CAP) };
  }
  return {
    coverage,
    merged,
    perUpload,
    detail: {
      schema: SCHEMA,
      key: o.key,
      sha: o.sha,
      groups: [...groups.values()].sort((a, b) => groupKey(a.flags).localeCompare(groupKey(b.flags))).map((g) => ({ flags: g.flags, files: encodeCoverage(g.cov) }))
    }
  };
}
function parseCarryforward(raw) {
  const v = raw.trim();
  if (!v || /^(false|no|off|0|none)$/i.test(v))
    return () => false;
  if (/^(true|yes|on|1|all)$/i.test(v))
    return () => true;
  const set = new Set(v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean));
  return (f) => set.has(f);
}

// src/version.ts
var VERSION = "1.0.0";
var GENERATOR = {
  name: "github-action-standalone-stats",
  version: VERSION
};

// src/publish/inputs.ts
function parseBool(raw, name, dflt) {
  const v = raw.trim().toLowerCase();
  if (v === "")
    return dflt;
  if (["true", "1", "yes", "on"].includes(v))
    return true;
  if (["false", "0", "no", "off"].includes(v))
    return false;
  throw new Error(`Invalid boolean for ${name}: ${JSON.stringify(raw)}`);
}
function parseIntInput(raw, name, dflt, min, max) {
  const v = raw.trim();
  if (!v)
    return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected an integer ${min}–${max})`);
  return n;
}
function checkBranch(b) {
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith("-") || b.includes("..") || b.endsWith("/") || b.endsWith(".lock"))
    throw new Error(`Invalid branch name: ${JSON.stringify(b)}`);
  return b;
}
function cleanPath(p) {
  const s = p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (s.split("/").some((seg) => seg === ".." || seg === ".git"))
    throw new Error(`Invalid path: ${JSON.stringify(p)}`);
  return s;
}
function readPublishInputs(getInput, currentRepo, envToken) {
  const repo = getInput("repo").trim() || currentRepo;
  parseRepo(repo);
  const foreign = repo.toLowerCase() !== currentRepo.toLowerCase();
  const token = getInput("token") || envToken || "";
  if (!token)
    throw new Error("No token. Set the `token` input (it defaults to github.token).");
  const rawPath = getInput("path");
  const path = cleanPath(rawPath.trim() ? rawPath : foreign ? `${currentRepo}/stats` : "stats");
  const visibility = getInput("repo-visibility").trim().toLowerCase() || "public";
  if (visibility !== "public" && visibility !== "private")
    throw new Error(`Invalid repo-visibility: ${JSON.stringify(visibility)} (expected public or private)`);
  const inputs = {
    repo,
    foreign,
    branch: checkBranch(getInput("branch").trim() || "gh-pages"),
    path,
    token,
    record: parseRecordMode(getInput("record")),
    tests: parseList(getInput("tests")).filter(Boolean),
    coverage: parseList(getInput("coverage")),
    components: parseComponents(getInput("components")),
    carryforward: getInput("carryforward"),
    detailWindow: parseIntInput(getInput("detail-window"), "detail-window", 50, 1, 1e4),
    patchCoverage: parseBool(getInput("patch-coverage"), "patch-coverage", true),
    flags: parseList(getInput("flags")),
    id: getInput("id").trim(),
    matrix: getInput("matrix"),
    downloadArtifacts: parseBool(getInput("download-artifacts"), "download-artifacts", true),
    artifactPrefix: getInput("artifact-prefix").trim() || DEFAULT_PREFIX,
    historyWindow: parseIntInput(getInput("history-window"), "history-window", 30, 1, 1000),
    viewer: parseBool(getInput("viewer"), "viewer", true),
    allowPublicPagesForPrivateRepo: parseBool(getInput("allow-public-pages-for-private-repo"), "allow-public-pages-for-private-repo", false),
    createRepo: parseBool(getInput("create-repo"), "create-repo", false),
    repoVisibility: visibility,
    failOnTestFailure: parseBool(getInput("fail-on-test-failure"), "fail-on-test-failure", false),
    pushAttempts: parseIntInput(getInput("push-attempts"), "push-attempts", 6, 1, 20),
    author: {
      name: getInput("commit-name").trim() || "github-actions[bot]",
      email: getInput("commit-email").trim() || "41898282+github-actions[bot]@users.noreply.github.com"
    },
    commitMessage: getInput("commit-message").trim()
  };
  const fmt = parseFormat(getInput("test-format"));
  if (fmt)
    inputs.testFormat = fmt;
  const covFmt = parseCoverageFormat(getInput("coverage-format"));
  if (covFmt)
    inputs.coverageFormat = covFmt;
  return inputs;
}

// src/publish/merge.ts
var FAILURE_CAP = 200;
function mergeTests(uploads) {
  const merged = new Map;
  for (const u of uploads) {
    for (const t of u.tests) {
      let m = merged.get(t.id);
      if (!m) {
        m = {
          id: t.id,
          suite: t.suite,
          name: t.name,
          status: t.status,
          durationMs: t.durationMs,
          flaky: false,
          byUpload: new Map
        };
        if (t.file)
          m.file = t.file;
        merged.set(t.id, m);
      }
      m.status = worse(m.status, t.status);
      m.durationMs = Math.max(m.durationMs, t.durationMs);
      if (t.flaky)
        m.flaky = true;
      const prev = m.byUpload.get(u.key);
      if (!prev || STATUS_SEVERITY[t.status] > STATUS_SEVERITY[prev.status])
        m.byUpload.set(u.key, t.message ? { status: t.status, message: t.message } : { status: t.status });
    }
  }
  return merged;
}
var isBad = (s) => s === "failed" || s === "errored";
function buildRecord(uploads, ctx) {
  const tests = mergeTests(uploads);
  let totals = emptyTotals();
  const summaries = uploads.map((u) => {
    const t = emptyTotals();
    for (const tc of u.tests)
      addTest(t, tc);
    totals = sumTotals(totals, t);
    const summary = {
      key: u.key,
      label: u.label,
      dims: u.dims,
      flags: u.flags,
      formats: [...new Set(u.sources.map((s) => s.format))],
      tests: t
    };
    const cov = ctx.coverage?.perUpload.get(u.key);
    if (cov)
      summary.coverage = cov;
    return summary;
  });
  const failures = [];
  let failing = 0;
  for (const m of tests.values()) {
    if (!isBad(m.status))
      continue;
    failing++;
    if (failures.length >= FAILURE_CAP)
      continue;
    const bad = [...m.byUpload].filter(([, r]) => isBad(r.status));
    const f = {
      id: m.id,
      suite: m.suite,
      name: m.name,
      status: m.status,
      uploads: bad.map(([k]) => k).sort()
    };
    if (m.file)
      f.file = m.file;
    const message = bad.find(([, r]) => r.message)?.[1].message;
    if (message)
      f.message = message;
    failures.push(f);
  }
  failures.sort((a, b) => a.id.localeCompare(b.id));
  const record = {
    schema: SCHEMA,
    key: `${ctx.run.id}-${ctx.run.attempt}`,
    time: (ctx.now ?? new Date).toISOString(),
    run: ctx.run,
    commit: ctx.commit,
    uploads: summaries,
    tests: {
      totals,
      unique: tests.size,
      flaky: [...tests.values()].filter((t) => t.flaky).length,
      failures,
      failuresTruncated: failing > failures.length
    }
  };
  if (ctx.coverage)
    record.coverage = ctx.coverage.coverage;
  return { record, tests };
}
function compare(current, tests, base) {
  const baseFailing = new Set(base.tests.failures.map((f) => f.id));
  const curFailing = new Set(current.tests.failures.map((f) => f.id));
  const newFailures = [...curFailing].filter((id) => !baseFailing.has(id)).sort();
  const stillFailing = [...curFailing].filter((id) => baseFailing.has(id)).sort();
  const fixed = [...baseFailing].filter((id) => !curFailing.has(id) && tests.get(id)?.status === "passed").sort();
  const c = current.tests.totals;
  const b = base.tests.totals;
  const cmp = {
    baseKey: base.key,
    baseSha: base.commit.sha,
    newFailures,
    fixed,
    stillFailing,
    delta: {
      total: c.total - b.total,
      failed: c.failed + c.errored - (b.failed + b.errored),
      durationMs: c.durationMs - b.durationMs
    }
  };
  if (current.coverage && base.coverage)
    cmp.coverage = { base: base.coverage.totals, baseRun: base };
  return cmp;
}

// src/publish/privacy.ts
function checkPrivacy(i) {
  if (!i.targetPrivate || i.allowPublic)
    return { ok: true };
  const p = i.pages;
  if (p.state === "none")
    return { ok: true };
  if (p.state === "unknown")
    return {
      ok: false,
      reason: `The stats repo is private and its Pages settings couldn't be read (HTTP ${p.status}). ` + "Grant `pages: read` to the job so the action can check whether Pages would make the stats public, " + "or set `allow-public-pages-for-private-repo: true` if that is intended."
    };
  if (!p.public)
    return { ok: true };
  if (p.buildType === "workflow")
    return {
      ok: true,
      warning: "This private repo deploys a public Pages site from a workflow. If you deploy the stats site-dir, its contents become public."
    };
  if (!p.source || p.source.branch === i.branch)
    return {
      ok: false,
      reason: `The stats repo is private, but its public GitHub Pages site serves branch \`${i.branch}\`, so publishing would make ` + "test names, file paths and failure messages public. Use a branch Pages does not serve, or set " + "`allow-public-pages-for-private-repo: true` if that is intended."
    };
  return { ok: true };
}

// src/publish/store.ts
import { cp, mkdir, readdir, readFile, rm as rm2, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join as join2 } from "node:path";

// src/badge.ts
var NARROW = new Set("fijlrt!|.,:;'()[]{} ");
var WIDE = new Set("mwMW%@");
function charWidth(c) {
  if (NARROW.has(c))
    return c === " " ? 3.9 : 3.6;
  if (WIDE.has(c))
    return 10.5;
  if (/[A-Z]/.test(c))
    return 7.6;
  if (/[0-9]/.test(c))
    return 7;
  if (/[a-z]/.test(c))
    return 6.4;
  return 7.5;
}
function textWidth(s) {
  let w = 0;
  for (const c of s)
    w += charWidth(c);
  return Math.ceil(w);
}
var escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var COLORS = {
  green: "#2e7d32",
  yellowgreen: "#7cb342",
  yellow: "#c79a00",
  orange: "#e65100",
  red: "#c62828",
  grey: "#6e6e6e"
};
function renderBadge(label, message, color) {
  const lw = textWidth(label) + 10;
  const mw = textWidth(message) + 10;
  const w = lw + mw;
  const l = escape(label);
  const m = escape(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${m}"><title>${l}: ${m}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><text aria-hidden="true" x="${lw * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${l}</text><text x="${lw * 5}" y="140" transform="scale(.1)">${l}</text><text aria-hidden="true" x="${(lw + mw / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${m}</text><text x="${(lw + mw / 2) * 10}" y="140" transform="scale(.1)">${m}</text></g></svg>`;
}
function testsBadge(t) {
  const bad = t.failed + t.errored;
  if (t.total === 0)
    return renderBadge("tests", "none", COLORS.grey);
  if (bad)
    return renderBadge("tests", `${bad} failing, ${t.passed} passing`, COLORS.red);
  const msg = t.skipped ? `${t.passed} passing, ${t.skipped} skipped` : `${t.passed} passing`;
  return renderBadge("tests", msg, COLORS.green);
}
function coverageColor(percent) {
  if (percent >= 90)
    return COLORS.green;
  if (percent >= 75)
    return COLORS.yellowgreen;
  if (percent >= 60)
    return COLORS.yellow;
  if (percent >= 40)
    return COLORS.orange;
  return COLORS.red;
}
function coverageBadge(label, [hit, total]) {
  if (!total)
    return renderBadge(label, "n/a", COLORS.grey);
  const p = Math.floor(1000 * hit / total) / 10;
  return renderBadge(label, `${p.toFixed(1)}%`, coverageColor(p));
}
function slug(name) {
  return name.toLowerCase().replace(/\+/g, "p").replace(/#/g, "sharp").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// src/publish/store.ts
function runPath(record) {
  const t = new Date(record.time);
  const yyyy = String(t.getUTCFullYear());
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `data/runs/${yyyy}/${mm}/${record.key}.json`;
}
async function readJson(path) {
  if (!existsSync(path))
    return;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return;
  }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}
`);
}
function entryOf(record, path) {
  const e = {
    key: record.key,
    time: record.time,
    sha: record.commit.sha,
    event: record.commit.event,
    url: record.run.url,
    tests: record.tests.totals,
    unique: record.tests.unique,
    flaky: record.tests.flaky,
    path
  };
  if (record.commit.branch)
    e.branch = record.commit.branch;
  const cov = record.coverage;
  if (cov) {
    const pair = (r) => [r.hit, r.total];
    const c = {
      l: pair(cov.totals.lines),
      b: pair(cov.totals.branches)
    };
    const comps = Object.entries(cov.components);
    if (comps.length)
      c.c = Object.fromEntries(comps.map(([k, v]) => [k, pair(v.lines)]));
    const flags = Object.entries(cov.flags);
    if (flags.length)
      c.f = Object.fromEntries(flags.map(([k, v]) => [k, pair(v.lines)]));
    if (cov.patch)
      c.p = pair(cov.patch);
    e.coverage = c;
  }
  return e;
}
async function* walkRuns(dir) {
  if (!existsSync(dir))
    return;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join2(dir, ent.name);
    if (ent.isDirectory())
      yield* walkRuns(p);
    else if (ent.name.endsWith(".json"))
      yield p;
  }
}
async function rebuildIndex(root, repo) {
  const runs = [];
  for await (const p of walkRuns(join2(root, "data", "runs"))) {
    const r = await readJson(p);
    if (r?.schema !== SCHEMA)
      continue;
    runs.push(entryOf(r, runPath(r)));
  }
  runs.sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
  return { schema: SCHEMA, repo, updated: new Date().toISOString(), runs };
}
async function readIndex(root, repo) {
  const idx = await readJson(join2(root, "data", "index.json"));
  if (idx?.schema === SCHEMA && Array.isArray(idx.runs))
    return idx;
  return rebuildIndex(root, repo);
}
function updateTestsIndex(prev, key, tests, window) {
  const idx = prev?.schema === SCHEMA && Array.isArray(prev.runs) ? prev : { schema: SCHEMA, runs: [], tests: {} };
  let pos = idx.runs.indexOf(key);
  if (pos < 0) {
    idx.runs.push(key);
    pos = idx.runs.length - 1;
    for (const t of Object.values(idx.tests)) {
      t.h += "-";
      t.d.push(-1);
    }
  }
  const n = idx.runs.length;
  for (const m of tests.values()) {
    let e = idx.tests[m.id];
    if (!e) {
      e = {
        suite: m.suite,
        name: m.name,
        h: "-".repeat(n),
        d: new Array(n).fill(-1)
      };
      if (m.file)
        e.file = m.file;
      idx.tests[m.id] = e;
    }
    e.h = e.h.slice(0, pos) + STATUS_CODE[m.status] + e.h.slice(pos + 1);
    e.d[pos] = m.durationMs;
  }
  const drop = Math.max(0, idx.runs.length - Math.max(1, window));
  if (drop) {
    idx.runs = idx.runs.slice(drop);
    for (const t of Object.values(idx.tests)) {
      t.h = t.h.slice(drop);
      t.d = t.d.slice(drop);
    }
  }
  for (const [id, t] of Object.entries(idx.tests))
    if (!/[^-]/.test(t.h))
      delete idx.tests[id];
  return idx;
}
async function applyRun(root, record, tests, opts) {
  const path = runPath(record);
  await writeJson(join2(root, path), record);
  if (record.coverage && opts.detail)
    await writeJson(join2(root, record.coverage.detail), opts.detail);
  const index = await readIndex(root, opts.repo);
  index.runs = index.runs.filter((r) => r.key !== record.key);
  index.runs.push(entryOf(record, path));
  index.runs.sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
  index.repo = opts.repo;
  index.updated = new Date().toISOString();
  await writeJson(join2(root, "data", "index.json"), index);
  const testsPath = join2(root, "data", "tests.json");
  const prevTests = await readJson(testsPath);
  await writeJson(testsPath, updateTestsIndex(prevTests, record.key, tests, opts.window));
  await writeJson(join2(root, "data", "meta.json"), {
    schema: SCHEMA,
    generator: opts.generator,
    repo: opts.repo,
    updated: index.updated
  });
  const newest = index.runs[index.runs.length - 1];
  await mkdir(join2(root, "badges"), { recursive: true });
  await writeFile(join2(root, "badges", "tests.svg"), testsBadge(newest.tests));
  const newestCov = [...index.runs].reverse().find((r) => r.coverage)?.coverage;
  if (newestCov)
    await writeCoverageBadges(join2(root, "badges"), newestCov);
  await pruneDetail(root, index, opts.detailWindow ?? 50);
  if (opts.viewerDir && existsSync(opts.viewerDir)) {
    await rm2(join2(root, "assets"), { recursive: true, force: true });
    await cp(opts.viewerDir, root, { recursive: true, force: true });
  }
  return index;
}
async function writeCoverageBadges(dir, c) {
  for (const f of await readdir(dir))
    if (/^(coverage-|flag-).*\.svg$/.test(f))
      await rm2(join2(dir, f));
  await writeFile(join2(dir, "coverage.svg"), coverageBadge("coverage", c.l));
  for (const [name, pair] of Object.entries(c.c ?? {}))
    await writeFile(join2(dir, `coverage-${slug(name)}.svg`), coverageBadge(name, pair));
  for (const [name, pair] of Object.entries(c.f ?? {}))
    await writeFile(join2(dir, `flag-${slug(name)}.svg`), coverageBadge(name, pair));
}
async function pruneDetail(root, index, window) {
  const dir = join2(root, "data", "detail");
  if (!existsSync(dir))
    return;
  const keep = new Set(index.runs.slice(-Math.max(1, window)).map((r) => `${r.key}.json`));
  for (const f of await readdir(dir))
    if (f.endsWith(".json") && !keep.has(f))
      await rm2(join2(dir, f));
}
async function readDetail(root, record) {
  const rel = record.coverage?.detail;
  if (!rel || !/^data\/detail\/[\w.-]+\.json$/.test(rel))
    return;
  const d = await readJson(join2(root, rel));
  return d?.schema === SCHEMA && Array.isArray(d.groups) ? d : undefined;
}
async function readBaseline(root, repo, branch, excludeRunId) {
  if (!existsSync(join2(root, "data")))
    return;
  const index = await readIndex(root, repo);
  for (let i = index.runs.length - 1;i >= 0; i--) {
    const e = index.runs[i];
    if (e.branch !== branch || excludeRunId !== undefined && e.key.startsWith(`${excludeRunId}-`))
      continue;
    const r = await readJson(join2(root, e.path));
    if (r?.schema === SCHEMA)
      return r;
  }
  return;
}

// src/publish/summary.ts
var md = (s) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");
var code = (s) => `\`${s.replace(/[`|]/g, "?")}\``;
function formatDuration(ms) {
  if (ms < 1000)
    return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60)
    return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}
var LIST_LIMIT = 25;
function deltaPct(cur, base) {
  const a = pct(cur);
  const b = base ? pct(base) : undefined;
  if (a === undefined || b === undefined)
    return "";
  const d = Math.round((a - b) * 100) / 100;
  if (d === 0)
    return "±0%";
  return `${d > 0 ? "+" : ""}${d.toFixed(2)}%`;
}
var ratio = (r) => r.total ? `${formatPct(r)} (${r.hit}/${r.total})` : "n/a";
function breakdown(title, cur, base) {
  const names = Object.keys(cur);
  if (!names.length)
    return [];
  const withBase = !!base;
  const out = [
    `| ${title} | Lines |${withBase ? " Δ |" : ""} Branches | Files |`,
    `| --- | ---: |${withBase ? " ---: |" : ""} ---: | ---: |`
  ];
  for (const n of names) {
    const c = cur[n];
    const d = withBase ? ` ${base?.[n] ? deltaPct(c.lines, base[n].lines) : "new"} |` : "";
    out.push(`| ${md(n)}${c.carried ? " (carried forward)" : ""} | ${ratio(c.lines)} |${d} ${ratio(c.branches)} | ${c.files} |`);
  }
  out.push("");
  return out;
}
function renderCoverage(cov, base, baseSha, badge, siteUrl) {
  const out = ["### Coverage", ""];
  if (badge && siteUrl)
    out.push(`[![coverage](${badge})](${siteUrl})`, "");
  const t = cov.totals;
  const d = base ? deltaPct(t.lines, base.totals.lines) : "";
  const bits = [
    `**Lines ${ratio(t.lines)}**${d ? ` (${d} vs \`${baseSha?.slice(0, 7)}\`)` : ""}`,
    t.branches.total ? `branches ${ratio(t.branches)}` : "",
    `${t.files} files`
  ].filter(Boolean);
  out.push(bits.join(" · "), "");
  if (cov.patch) {
    const p = cov.patch;
    out.push(p.total ? `**Patch ${ratio(p)}**: changed lines that ran${p.partial ? " (diff incomplete: too many files)" : ""}.` : "Patch: no coverable lines changed.", "");
  }
  if (cov.carriedForward.length)
    out.push(`Carried forward from the baseline (not run this time): ${cov.carriedForward.map(code).join(", ")}.`, "");
  if (Object.keys(cov.components).length > 1)
    out.push(...breakdown("Component", cov.components, base?.components));
  out.push(...breakdown("Flag", cov.flags, base?.flags));
  const missed = cov.patch?.files.filter((f) => f.hit < f.total) ?? [];
  if (missed.length) {
    const rows = missed.slice(0, LIST_LIMIT).map((f) => `| ${code(f.path)} | ${ratio(f)} | ${f.total - f.hit} |`);
    out.push(`<details><summary>Changed files with uncovered lines (${missed.length})</summary>`, "", "| File | Patch | Missed |", "| --- | ---: | ---: |", ...rows, "", missed.length > LIST_LIMIT ? `…and ${missed.length - LIST_LIMIT} more
` : "", "</details>", "");
  }
  return out;
}
function list(title, ids) {
  if (!ids.length)
    return "";
  const shown = ids.slice(0, LIST_LIMIT).map((id) => `- ${md(id)}`);
  if (ids.length > LIST_LIMIT)
    shown.push(`- …and ${ids.length - LIST_LIMIT} more`);
  return `<details><summary>${title} (${ids.length})</summary>

${shown.join(`
`)}

</details>
`;
}
function renderSummary(record, cmp, links) {
  const t = record.tests.totals;
  const bad = t.failed + t.errored;
  const out = ["## Standalone Stats", ""];
  if (links.badgeUrl && links.siteUrl)
    out.push(`[![tests](${links.badgeUrl})](${links.siteUrl})`, "");
  const hasTests = record.uploads.some((u) => u.tests.total > 0);
  if (!record.uploads.length) {
    out.push("No test results or coverage were found for this run.", "");
  } else if (!hasTests) {} else {
    const parts = [
      `${bad ? "❌" : "✅"} **${t.passed}** passed`,
      bad ? `**${bad}** failing` : "",
      t.skipped ? `${t.skipped} skipped` : "",
      t.other ? `${t.other} other` : ""
    ].filter(Boolean);
    const jobs = record.uploads.length;
    out.push(`${parts.join(" · ")} — ${t.total} results from ${record.tests.unique} tests across ${jobs} job${jobs === 1 ? "" : "s"}, ${formatDuration(t.durationMs)} total`, "");
    if (record.tests.flaky)
      out.push(`⚠️ ${record.tests.flaky} flaky (passed on retry)`, "");
    if (cmp) {
      const sha = cmp.baseSha.slice(0, 7);
      const bits = [
        cmp.newFailures.length ? `**${cmp.newFailures.length} new failure${cmp.newFailures.length === 1 ? "" : "s"}**` : "no new failures",
        cmp.fixed.length ? `${cmp.fixed.length} fixed` : "",
        cmp.stillFailing.length ? `${cmp.stillFailing.length} still failing` : "",
        cmp.delta.total ? `${signed(cmp.delta.total)} results` : ""
      ].filter(Boolean);
      out.push(`Compared with \`${sha}\`: ${bits.join(", ")}.`, "");
    }
    const covCol = record.uploads.some((u) => u.coverage);
    out.push(`| Job | Passed | Failed | Skipped | Time |${covCol ? " Lines |" : ""}`, `| --- | ---: | ---: | ---: | ---: |${covCol ? " ---: |" : ""}`);
    for (const u of record.uploads) {
      const f = u.tests.failed + u.tests.errored;
      const c = covCol ? ` ${u.coverage ? formatPct(u.coverage.lines) : ""} |` : "";
      out.push(`| ${md(u.label)} | ${u.tests.passed} | ${f ? `**${f}**` : 0} | ${u.tests.skipped} | ${formatDuration(u.tests.durationMs)} |${c}`);
    }
    out.push("");
    if (cmp) {
      out.push(list("New failures", cmp.newFailures));
      out.push(list("Fixed", cmp.fixed));
    }
    const failures = record.tests.failures;
    if (failures.length) {
      const labels = new Map(record.uploads.map((u) => [u.key, u.label]));
      const rows = failures.slice(0, LIST_LIMIT).map((f) => {
        const where = f.uploads.map((k) => labels.get(k) ?? k).join(", ");
        const msg = f.message ? `

  \`\`\`
  ${f.message.split(`
`).slice(0, 8).join(`
  `)}
  \`\`\`` : "";
        return `- **${md(f.id)}** (${md(where)})${msg}`;
      });
      const more = record.tests.failuresTruncated || failures.length > LIST_LIMIT ? `
- …more in the dashboard` : "";
      out.push(`<details><summary>Failures (${failures.length}${record.tests.failuresTruncated ? "+" : ""})</summary>

${rows.join(`
`)}${more}

</details>
`);
    }
  }
  if (record.coverage)
    out.push(...renderCoverage(record.coverage, cmp?.coverage?.baseRun.coverage, cmp?.baseSha, links.coverageBadgeUrl, links.siteUrl));
  if (links.siteUrl)
    out.push(`Dashboard: ${links.siteUrl}`, "");
  if (links.note)
    out.push(`> ${links.note}`, "");
  else if (!links.recorded)
    out.push("> This run was compared but not recorded in history.", "");
  return out.filter((s) => s !== undefined).join(`
`).replace(/\n{3,}/g, `

`);
}

// src/publish/main.ts
async function loadBaseline(root, repo, branch, excludeRunId) {
  const record = await readBaseline(root, repo, branch, excludeRunId);
  if (!record)
    return;
  const detail = await readDetail(root, record);
  return detail ? { record, detail } : { record };
}
var viewerDir = () => fileURLToPath(new URL("../viewer/", import.meta.url));
async function collectUploads(inputs, ctx) {
  const uploads = [];
  if (inputs.tests.length || inputs.coverage.length) {
    const id = identity(ctx.job, parseMatrix(inputs.matrix), inputs.id, ctx.runnerOs);
    const local = await gather({
      identity: id,
      testPatterns: inputs.tests,
      ...inputs.testFormat ? { testFormat: inputs.testFormat } : {},
      coveragePatterns: inputs.coverage,
      ...inputs.coverageFormat ? { coverageFormat: inputs.coverageFormat } : {},
      warn: (m) => warning(m),
      flags: inputs.flags,
      workspace: ctx.workspace,
      attempt: ctx.run.attempt
    });
    if (inputs.tests.length && !local.sources.length)
      warning(`No test results matched: ${inputs.tests.join(", ")}`);
    if (inputs.coverage.length && !local.coverage)
      warning(`No coverage reports matched: ${inputs.coverage.join(", ")}`);
    uploads.push(local);
  }
  if (inputs.downloadArtifacts) {
    if (!process.env.ACTIONS_RUNTIME_TOKEN) {
      info("No Actions runtime token, so collect artifacts were not downloaded.");
    } else {
      const downloaded = await downloadUploads(inputs.artifactPrefix);
      info(`Downloaded ${downloaded.length} collect upload${downloaded.length === 1 ? "" : "s"}`);
      uploads.push(...downloaded);
    }
  }
  return dedupe(uploads);
}
async function readOnlyBaseline(remote, inputs, ctx, branch) {
  try {
    if (!await remoteHasBranch(remote, inputs.branch))
      return;
    const { dir } = await checkout(remote, inputs.branch);
    try {
      return await loadBaseline(join3(dir, inputs.path), inputs.repo, branch, ctx.run.id);
    } finally {
      await rm3(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    warning(`Could not read the baseline, so nothing is compared: ${err.message}`);
    return;
  }
}
async function run() {
  const ctx = readContext();
  const inputs = readPublishInputs((n) => getInput(n), ctx.repo, process.env.GITHUB_TOKEN);
  setSecret(inputs.token);
  const target = parseRepo(inputs.repo);
  const remote = {
    url: `${ctx.serverUrl}/${inputs.repo}.git`,
    token: inputs.token
  };
  const api = { token: inputs.token };
  const uploads = await collectUploads(inputs, ctx);
  if (!uploads.length)
    warning("No results: nothing matched `tests` or `coverage`, and no collect artifacts were found in this run.");
  let diff;
  if (inputs.patchCoverage && ctx.patchBase && uploads.some((u) => u.coverage)) {
    try {
      const d = await compareDiff(parseRepo(ctx.repo), ctx.patchBase, ctx.commit.sha, api);
      if (d)
        diff = { diff: d, base: ctx.patchBase };
    } catch (err) {
      warning(`Patch coverage skipped: ${err.message}`);
    }
  }
  const carryforward = parseCarryforward(inputs.carryforward);
  const build = (base) => {
    const cov = buildCoverage(uploads, {
      key: `${ctx.run.id}-${ctx.run.attempt}`,
      sha: ctx.commit.sha,
      components: inputs.components,
      carryforward,
      ...base?.detail ? { baselineDetail: base.detail } : {},
      ...diff ? { diff } : {}
    });
    return {
      ...buildRecord(uploads, {
        run: ctx.run,
        commit: ctx.commit,
        ...cov ? { coverage: cov } : {}
      }),
      cov
    };
  };
  let built = build();
  const baseBranch = ctx.baseBranch ?? ctx.defaultBranch;
  let recorded = false;
  let note;
  let baseline;
  let siteUrl;
  let wantRecord = shouldRecord(inputs.record, ctx) && uploads.length > 0;
  if (wantRecord && ctx.fromFork) {
    wantRecord = false;
    note = "Pull requests from forks have a read-only token, so this run was compared but not recorded.";
  }
  if (wantRecord) {
    let info2 = await getRepo(target, api);
    if (!info2 && inputs.foreign && inputs.createRepo) {
      info(`Creating stats repo ${inputs.repo}`);
      await createRepo(target, { ...api, visibility: inputs.repoVisibility });
      info2 = await getRepo(target, api);
    }
    if (!info2)
      throw new Error(`Stats repo ${inputs.repo} doesn't exist or isn't readable with this token.`);
    const pages = await getPages(target, api);
    const privacy = checkPrivacy({
      targetPrivate: info2.private,
      pages,
      branch: inputs.branch,
      allowPublic: inputs.allowPublicPagesForPrivateRepo
    });
    if (!privacy.ok) {
      wantRecord = false;
      note = privacy.reason;
      warning(privacy.reason);
    } else if (privacy.warning)
      warning(privacy.warning);
    if (pages.state === "enabled" && pages.url)
      siteUrl = `${pages.url.replace(/\/+$/, "")}/${inputs.path ? `${inputs.path}/` : ""}`;
    if (wantRecord && pages.state === "none" && inputs.foreign && inputs.createRepo)
      await enablePages(target, inputs.branch, api).catch(() => {});
  }
  siteUrl ??= defaultPagesUrl(target, inputs.path);
  if (wantRecord) {
    const message = inputs.commitMessage || `stats: ${ctx.repo}@${ctx.commit.sha.slice(0, 7)} (run ${ctx.run.id}/${ctx.run.attempt})`;
    const result = await publishBranch({
      remote,
      branch: inputs.branch,
      message,
      author: inputs.author,
      attempts: inputs.pushAttempts,
      apply: async (dir, fresh) => {
        const root = inputs.path ? join3(dir, inputs.path) : dir;
        await mkdir2(root, { recursive: true });
        if (fresh)
          await writeFile2(join3(dir, ".nojekyll"), "");
        baseline = baseBranch ? await loadBaseline(root, inputs.repo, baseBranch, ctx.run.id) : undefined;
        built = build(baseline);
        await applyRun(root, built.record, built.tests, {
          repo: ctx.repo,
          window: inputs.historyWindow,
          detailWindow: inputs.detailWindow,
          ...built.cov ? { detail: built.cov.detail } : {},
          ...inputs.viewer && existsSync2(viewerDir()) ? { viewerDir: viewerDir() } : {},
          generator: GENERATOR
        });
      }
    });
    try {
      recorded = result.committed;
      info(result.committed ? `Published to ${inputs.repo}:${inputs.branch}/${inputs.path} (attempt ${result.attempts})` : "Nothing changed on the stats branch.");
      const siteDir = join3(process.env.RUNNER_TEMP || result.dir, "standalone-stats-site");
      await rm3(siteDir, { recursive: true, force: true });
      await cp2(inputs.path ? join3(result.dir, inputs.path) : result.dir, siteDir, {
        recursive: true,
        filter: (src) => !src.split(/[\\/]/).includes(".git")
      });
      setOutput("site-dir", siteDir);
    } finally {
      await rm3(result.dir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (baseBranch) {
    baseline = await readOnlyBaseline(remote, inputs, ctx, baseBranch);
    built = build(baseline);
  }
  const { record, tests } = built;
  if (record.coverage?.carriedForward.length)
    info(`Carried forward from the baseline: ${record.coverage.carriedForward.join(", ")}`);
  const cmp = baseline ? compare(record, tests, baseline.record) : undefined;
  publishOutputs(record, cmp?.newFailures.length ?? 0, siteUrl, recorded);
  const badgeUrl = `${siteUrl}badges/tests.svg`;
  const summaryLinks = {
    siteUrl,
    badgeUrl,
    coverageBadgeUrl: `${siteUrl}badges/coverage.svg`,
    recorded,
    ...note ? { note } : {}
  };
  await summary.addRaw(renderSummary(record, cmp, summaryLinks)).write();
  const bad = record.tests.totals.failed + record.tests.totals.errored;
  if (inputs.failOnTestFailure && bad)
    setFailed(`${bad} test result${bad === 1 ? "" : "s"} failed`);
}
function publishOutputs(record, newFailures, siteUrl, recorded) {
  const t = record.tests.totals;
  const badgeUrl = `${siteUrl}badges/tests.svg`;
  setOutput("site-url", siteUrl);
  setOutput("badge-url", badgeUrl);
  setOutput("badge-markdown", `[![tests](${badgeUrl})](${siteUrl})`);
  setOutput("recorded", String(recorded));
  setOutput("run-key", record.key);
  setOutput("tests-total", String(t.total));
  setOutput("tests-passed", String(t.passed));
  setOutput("tests-failed", String(t.failed + t.errored));
  setOutput("tests-skipped", String(t.skipped));
  setOutput("new-failures", String(newFailures));
  const cov = record.coverage;
  const fmt = (r) => r ? pct(r)?.toFixed(2) ?? "" : "";
  setOutput("coverage-lines", fmt(cov?.totals.lines));
  setOutput("coverage-branches", fmt(cov?.totals.branches));
  setOutput("coverage-patch", fmt(cov?.patch));
  const covBadge = `${siteUrl}badges/coverage.svg`;
  setOutput("coverage-badge-url", cov ? covBadge : "");
  setOutput("coverage-badge-markdown", cov ? `[![coverage](${covBadge})](${siteUrl})` : "");
}
run().catch((err) => {
  setFailed(err instanceof Error ? err.message : String(err));
});
