import {
  debug,
  warning,
  info,
  SCHEMA,
  STATUS_SEVERITY,
  pct,
  formatPct,
  DefaultArtifactClient
} from "./main-9x83tt5p.js";

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

class PermissionError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
function fail(what, status, body) {
  const msg = body?.message ?? "";
  const text = `${what}: status ${status}${msg ? ` (${msg})` : ""}`;
  if (status === 403 || status === 404)
    throw new PermissionError(text, status);
  throw new Error(text);
}
async function listComments(ref, issue, opts) {
  const out = [];
  for (let page = 1;page <= 30; page++) {
    const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments?per_page=100&page=${page}`, undefined, opts);
    if (status !== 200)
      fail(`Listing comments on #${issue}`, status, body);
    out.push(...body);
    if (body.length < 100)
      break;
  }
  return out;
}
async function createComment(ref, issue, text, opts) {
  const { status, body } = await api("POST", `/repos/${ref.owner}/${ref.name}/issues/${issue}/comments`, { body: text }, opts);
  if (status !== 201)
    fail(`Commenting on #${issue}`, status, body);
  return body;
}
async function updateComment(ref, id, text, opts) {
  const { status, body } = await api("PATCH", `/repos/${ref.owner}/${ref.name}/issues/comments/${id}`, { body: text }, opts);
  if (status !== 200)
    fail(`Updating comment ${id}`, status, body);
  return body;
}
async function createStatus(ref, sha, s, opts) {
  const { status, body } = await api("POST", `/repos/${ref.owner}/${ref.name}/statuses/${encodeURIComponent(sha)}`, s, opts);
  if (status !== 201)
    fail(`Setting status ${s.context}`, status, body);
}
async function getRun(ref, id, opts) {
  const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}/actions/runs/${id}`, undefined, opts);
  if (status !== 200)
    fail(`Reading run ${id}`, status, body);
  return body;
}
async function getPull(ref, n, opts) {
  const { status, body } = await api("GET", `/repos/${ref.owner}/${ref.name}/pulls/${n}`, undefined, opts);
  if (status === 404)
    return;
  if (status !== 200)
    fail(`Reading PR #${n}`, status, body);
  return body;
}

// src/publish/summary.ts
var md = (s) => s.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/@(?=[\w-])|#(?=\d)/g, "$&&#8203;");
var code = (s) => `\`${s.replace(/[`|\n]/g, "?")}\``;
function fence(text, indent = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return [f, ...text.split(`
`), f].map((l) => `${indent}${l}`).join(`
`);
}
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
    return "±0";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} pts`;
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
  out.push(...missedFiles(cov));
  return out;
}
function missedFiles(cov) {
  const missed = cov.patch?.files.filter((f) => f.hit < f.total) ?? [];
  if (!missed.length)
    return [];
  const rows = missed.slice(0, LIST_LIMIT).map((f) => `| ${code(f.path)} | ${ratio(f)} | ${f.total - f.hit} |`);
  return [
    `<details><summary>Changed files with uncovered lines (${missed.length})</summary>`,
    "",
    "| File | Patch | Missed |",
    "| --- | ---: | ---: |",
    ...rows,
    "",
    missed.length > LIST_LIMIT ? `…and ${missed.length - LIST_LIMIT} more
` : "",
    "</details>",
    ""
  ];
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

${fence(f.message.split(`
`).slice(0, 8).join(`
`), "  ")}` : "";
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

// src/thresholds.ts
function parseThresholds(raw) {
  const rules = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const text = line.replace(/(^|\s)#.*$/, "").trim();
    if (!text)
      continue;
    const m = text.match(/^(.+?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*%?$/);
    if (!m)
      throw new Error(`thresholds line ${i + 1}: expected "name: number", got ${JSON.stringify(line)}`);
    const key = m[1].trim();
    const value = Number(m[2]);
    const scoped = key.match(/^(component|flag)\s+(.+)$/i);
    if (scoped) {
      rules.push({
        kind: scoped[1].toLowerCase(),
        name: scoped[2].trim(),
        value: checkPct(value, i)
      });
      continue;
    }
    const kind = key.toLowerCase();
    if (kind === "total" || kind === "lines" || kind === "project")
      rules.push({ kind: "total", value: checkPct(value, i) });
    else if (kind === "branches" || kind === "patch")
      rules.push({ kind, value: checkPct(value, i) });
    else if (kind === "drop")
      rules.push({ kind: "drop", value });
    else
      throw new Error(`thresholds line ${i + 1}: unknown rule ${JSON.stringify(key)} (expected total, branches, patch, drop, "component <name>" or "flag <name>")`);
  }
  return rules;
}
function checkPct(v, i) {
  if (v > 100)
    throw new Error(`thresholds line ${i + 1}: ${v} is over 100%`);
  return v;
}
var exact = (r) => r.total ? 100 * r.hit / r.total : undefined;
var show = (p) => `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
var pts = (p) => `${(Math.round(p * 100) / 100).toFixed(2)} pts`;
function ruleLabel(rule) {
  return "name" in rule ? `${rule.kind} ${rule.name}` : rule.kind;
}
function evaluate(rules, cov, base) {
  return rules.map((rule) => {
    const label = ruleLabel(rule);
    const group = rule.kind === "patch" ? "patch" : "coverage";
    const min = (r) => {
      const p = r ? exact(r) : undefined;
      if (p === undefined)
        return { rule, group, label, text: "no data" };
      return {
        rule,
        group,
        label,
        actual: p,
        ok: p >= rule.value,
        text: `${show(p)} (min ${rule.value}%)`
      };
    };
    switch (rule.kind) {
      case "total":
        return min(cov?.totals.lines);
      case "branches":
        return min(cov?.totals.branches);
      case "patch":
        return min(cov?.patch);
      case "component":
        return min(cov?.components[rule.name]?.lines);
      case "flag":
        return min(cov?.flags[rule.name]?.lines);
      case "drop": {
        const cur = cov ? exact(cov.totals.lines) : undefined;
        const was = base ? exact(base.totals.lines) : undefined;
        if (cur === undefined || was === undefined)
          return { rule, group, label, text: "no baseline" };
        const d = Math.max(0, was - cur);
        return {
          rule,
          group,
          label,
          actual: d,
          ok: d <= rule.value + 0.000000001,
          text: `${cur < was ? `−${pts(was - cur)}` : `+${pts(cur - was)}`} vs baseline (max drop ${rule.value})`
        };
      }
    }
  });
}
var STATUS_PREFIX = "standalone-stats";
function statusesFor(results) {
  const out = [];
  for (const group of ["coverage", "patch"]) {
    const rs = results.filter((r) => r.group === group);
    if (!rs.length)
      continue;
    const failed = rs.filter((r) => r.ok === false);
    const measured = rs.filter((r) => r.ok !== undefined);
    const shown = failed.length ? failed : measured;
    let description = shown.length ? shown.map((r) => group === "patch" ? r.text : `${r.label} ${r.text}`).join("; ") : "Nothing to measure";
    if (description.length > 140)
      description = `${description.slice(0, 139)}…`;
    out.push({
      context: `${STATUS_PREFIX}/${group}`,
      state: failed.length ? "failure" : "success",
      description
    });
  }
  return out;
}
var failedRules = (results) => results.filter((r) => r.ok === false);

// src/report.ts
var REPORT_ARTIFACT = "standalone-stats-report";
var REPORT_FILE = "report.json";
var REPORT_KIND = "standalone-stats-report";
var COMMENT_MAX = 60000;
var MAX_REPORT_BYTES = 5000000;
function buildReport(args) {
  const { record, cmp } = args;
  const run = {
    key: record.key,
    sha: record.commit.sha,
    uploads: record.uploads.map((u) => {
      const s = {
        key: u.key,
        label: u.label,
        tests: u.tests
      };
      if (u.coverage)
        s.coverage = u.coverage;
      return s;
    }),
    tests: {
      totals: record.tests.totals,
      unique: record.tests.unique,
      flaky: record.tests.flaky,
      failures: record.tests.failures,
      failuresTruncated: record.tests.failuresTruncated,
      ...record.tests.byTest ? { byTest: record.tests.byTest } : {}
    },
    ...record.coverage ? { coverage: record.coverage } : {}
  };
  const r = {
    kind: REPORT_KIND,
    schema: SCHEMA,
    workflow: args.workflow,
    runId: record.run.id,
    attempt: record.run.attempt,
    runUrl: args.runUrl,
    run,
    recorded: args.recorded,
    rules: args.rules,
    wants: args.wants
  };
  if (args.pr)
    r.pr = args.pr;
  if (args.siteUrl)
    r.siteUrl = args.siteUrl;
  if (args.note)
    r.note = args.note;
  if (cmp) {
    r.comparison = {
      baseKey: cmp.baseKey,
      baseSha: cmp.baseSha,
      newFailures: cmp.newFailures,
      fixed: cmp.fixed,
      stillFailing: cmp.stillFailing,
      delta: cmp.delta,
      ...cmp.coverage?.baseRun.coverage ? { baseCoverage: cmp.coverage.baseRun.coverage } : {}
    };
  }
  return r;
}
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var arr = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
var str = (v, max = 500) => typeof v === "string" ? v.slice(0, max) : "";
var int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
var signedInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
var sha = (v) => {
  const s = str(v, 64);
  return /^[0-9a-f]{7,64}$/i.test(s) ? s : "";
};
function totals(v) {
  const o = obj(v);
  return {
    total: int(o.total),
    passed: int(o.passed),
    failed: int(o.failed),
    errored: int(o.errored),
    skipped: int(o.skipped),
    other: int(o.other),
    durationMs: int(o.durationMs)
  };
}
function ratio2(v) {
  const o = obj(v);
  const total = int(o.total);
  return { hit: Math.min(int(o.hit), total), total };
}
function covTotals(v) {
  const o = obj(v);
  return {
    files: int(o.files),
    lines: ratio2(o.lines),
    branches: ratio2(o.branches)
  };
}
function named(v, f, max = 200) {
  const out = {};
  for (const [k, x] of Object.entries(obj(v)).slice(0, max))
    out[str(k, 100)] = f(x);
  return out;
}
function coverage(v) {
  if (!v || typeof v !== "object")
    return;
  const o = obj(v);
  const c = {
    totals: covTotals(o.totals),
    flags: named(o.flags, (x) => {
      const t = covTotals(x);
      if (obj(x).carried === true)
        t.carried = true;
      return t;
    }),
    components: named(o.components, covTotals),
    carriedForward: arr(o.carriedForward, 200).map((x) => str(x, 100)),
    detail: ""
  };
  if (o.patch && typeof o.patch === "object") {
    const p = obj(o.patch);
    c.patch = {
      ...ratio2(p),
      base: sha(p.base),
      partial: p.partial === true,
      files: arr(p.files, 500).map((f) => ({
        path: str(obj(f).path, 500),
        ...ratio2(f)
      }))
    };
  }
  return c;
}
var STATUSES = Object.keys(STATUS_SEVERITY);
function failure(v) {
  const o = obj(v);
  const f = {
    id: str(o.id, 1000),
    suite: str(o.suite, 1000),
    name: str(o.name, 1000),
    status: STATUSES.find((s) => s === o.status) ?? "failed",
    uploads: arr(o.uploads, 100).map((x) => str(x, 64))
  };
  const m = str(o.message, 2000);
  if (m)
    f.message = m;
  return f;
}
function rule(v) {
  const o = obj(v);
  const value = Number(o.value);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    return;
  if (o.kind === "total" || o.kind === "branches" || o.kind === "patch" || o.kind === "drop")
    return { kind: o.kind, value };
  if ((o.kind === "component" || o.kind === "flag") && typeof o.name === "string")
    return { kind: o.kind, name: str(o.name, 100), value };
  return;
}
function safeUrl(v, trustedHosts) {
  const s = str(v, 2000);
  if (!s)
    return;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:")
      return;
    const host = u.hostname.toLowerCase();
    if (host.endsWith(".github.io") || trustedHosts.includes(host))
      return u.toString();
  } catch {}
  return;
}
function sanitizeReport(text, trustedHosts = []) {
  if (text.length > MAX_REPORT_BYTES)
    throw new Error(`report is ${text.length} bytes (max ${MAX_REPORT_BYTES})`);
  const o = obj(JSON.parse(text));
  if (o.kind !== REPORT_KIND)
    throw new Error("not a standalone-stats report");
  if (o.schema !== SCHEMA)
    throw new Error(`unsupported report schema ${String(o.schema)}`);
  const run = obj(o.run);
  const tests = obj(run.tests);
  const r = {
    kind: REPORT_KIND,
    schema: SCHEMA,
    workflow: str(o.workflow, 100),
    runId: int(o.runId),
    attempt: int(o.attempt) || 1,
    runUrl: "",
    run: {
      key: str(run.key, 64),
      sha: sha(run.sha),
      uploads: arr(run.uploads, 256).map((u) => {
        const x = obj(u);
        const s = {
          key: str(x.key, 64),
          label: str(x.label, 200),
          tests: totals(x.tests)
        };
        if (x.coverage && typeof x.coverage === "object")
          s.coverage = covTotals(x.coverage);
        return s;
      }),
      tests: {
        totals: totals(tests.totals),
        unique: int(tests.unique),
        flaky: int(tests.flaky),
        failures: arr(tests.failures, 100).map(failure),
        failuresTruncated: tests.failuresTruncated === true,
        ...tests.byTest ? { byTest: totals(tests.byTest) } : {}
      }
    },
    recorded: o.recorded === true,
    rules: arr(o.rules, 100).map(rule).filter((x) => !!x),
    wants: {
      comment: obj(o.wants).comment === true,
      statuses: obj(o.wants).statuses === true
    }
  };
  const cov = coverage(run.coverage);
  if (cov)
    r.run.coverage = cov;
  const pr = int(o.pr);
  if (pr)
    r.pr = pr;
  const site = safeUrl(o.siteUrl, trustedHosts);
  if (site)
    r.siteUrl = site;
  const note = str(o.note, 500);
  if (note)
    r.note = note;
  if (o.comparison && typeof o.comparison === "object") {
    const c = obj(o.comparison);
    const ids = (v) => arr(v, 200).map((x) => str(x, 1000));
    const d = obj(c.delta);
    r.comparison = {
      baseKey: str(c.baseKey, 64),
      baseSha: sha(c.baseSha),
      newFailures: ids(c.newFailures),
      fixed: ids(c.fixed),
      stillFailing: ids(c.stillFailing),
      delta: {
        total: signedInt(d.total),
        failed: signedInt(d.failed),
        durationMs: signedInt(d.durationMs)
      }
    };
    const bc = coverage(c.baseCoverage);
    if (bc)
      r.comparison.baseCoverage = bc;
  }
  return r;
}
var markerName = (workflow) => workflow.replace(/[^\w .-]/g, "").replace(/-{2,}/g, "-").trim() || "workflow";
function marker(r) {
  return `<!-- standalone-stats:${markerName(r.workflow)} run=${r.runId}-${r.attempt} -->`;
}
var markerPrefix = (workflow) => `<!-- standalone-stats:${markerName(workflow)} run=`;
function markerRun(body, workflow) {
  const at = body.indexOf(markerPrefix(workflow));
  if (at < 0)
    return;
  const m = body.slice(at + markerPrefix(workflow).length).match(/^(\d+)-(\d+)/);
  return m ? Number(m[1]) : undefined;
}
var plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function thresholdLine(results) {
  if (!results.length)
    return "";
  const icon = (r) => r.ok === false ? "❌" : r.ok ? "✅" : "➖";
  const sorted = [...results].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false));
  return `**Thresholds:** ${sorted.map((r) => `${icon(r)} ${md(r.label)} ${r.text}`).join(" · ")}`;
}
function isQuiet(r, results) {
  const c = r.comparison;
  if (!c)
    return false;
  if (failedRules(results).length)
    return false;
  const t = r.run.tests;
  if (t.failures.length || t.flaky)
    return false;
  if (c.newFailures.length || c.fixed.length || c.delta.total)
    return false;
  const cov = r.run.coverage;
  if (cov) {
    if (!c.baseCoverage)
      return false;
    if (deltaPct(cov.totals.lines, c.baseCoverage.totals.lines) !== "±0")
      return false;
    if (cov.patch && cov.patch.total > 0)
      return false;
  }
  return true;
}
function testCounts(r) {
  return r.run.tests.byTest ?? r.run.tests.totals;
}
function renderComment(r, rules = r.rules) {
  const results = evaluate(rules, r.run.coverage, r.comparison?.baseCoverage);
  const t = testCounts(r);
  const bad = t.failed + t.errored;
  const failing = failedRules(results).length > 0;
  const c = r.comparison;
  const short = r.run.sha.slice(0, 7);
  const baseRef = c?.baseSha ? code(c.baseSha.slice(0, 7)) : "";
  const links = [
    r.siteUrl ? `[Dashboard](${r.siteUrl})` : "",
    r.runUrl ? `[Run](${r.runUrl})` : ""
  ].filter(Boolean);
  const head = marker(r);
  if (isQuiet(r, results)) {
    const bits = [
      t.total ? `${t.passed} tests passing` : "",
      r.run.coverage ? `${formatPct(r.run.coverage.totals.lines)} lines` : "",
      ...links
    ].filter(Boolean);
    const thr = results.length ? `

${thresholdLine(results)}` : "";
    return `${head}
✅ **Standalone Stats** for ${code(short)}: no test or coverage changes vs ${baseRef}. ${bits.join(" · ")}${thr}
`;
  }
  const ok = !bad && !failing;
  const out = [
    head,
    `### ${ok ? "✅" : "❌"} Standalone Stats for ${code(short)}`,
    ""
  ];
  const thr = thresholdLine(results);
  if (thr)
    out.push(thr, "");
  if (t.total) {
    const parts = [
      `**${t.passed}** passed`,
      bad ? `**${bad}** failing` : "",
      t.skipped ? `${t.skipped} skipped` : "",
      r.run.tests.flaky ? `⚠️ ${r.run.tests.flaky} flaky` : ""
    ].filter(Boolean);
    const jobs = r.run.uploads.length;
    const results_ = r.run.tests.totals.total;
    out.push(`${bad ? "❌" : "✅"} ${parts.join(" · ")} — ${plural(t.total, "test")}${results_ !== t.total ? ` (${results_} results across ${plural(jobs, "job")})` : ""}`, "");
    if (c) {
      const bits = [
        c.newFailures.length ? `**${plural(c.newFailures.length, "new failure")}**` : "no new failures",
        c.fixed.length ? `${c.fixed.length} fixed` : "",
        c.stillFailing.length ? `${c.stillFailing.length} still failing` : ""
      ].filter(Boolean);
      out.push(`Compared with ${baseRef}: ${bits.join(", ")}.`, "");
    }
  }
  const cov = r.run.coverage;
  if (cov) {
    const d = deltaPct(cov.totals.lines, c?.baseCoverage?.totals.lines);
    const bits = [
      `**Coverage ${formatPct(cov.totals.lines)}**${d ? ` (${d})` : ""}`,
      cov.patch ? cov.patch.total ? `**Patch ${formatPct(cov.patch)}** (${cov.patch.hit}/${cov.patch.total} changed lines ran${cov.patch.partial ? ", diff incomplete" : ""})` : "no coverable lines changed" : ""
    ].filter(Boolean);
    out.push(bits.join(" · "), "");
  }
  const details = [];
  if (c?.newFailures.length)
    details.push(list2("New failures", c.newFailures));
  if (c?.fixed.length)
    details.push(list2("Fixed", c.fixed));
  const failures = r.run.tests.failures;
  if (failures.length) {
    const labels = new Map(r.run.uploads.map((u) => [u.key, u.label]));
    const rows = failures.slice(0, 25).map((f) => {
      const where = f.uploads.map((k) => labels.get(k) ?? k).join(", ");
      const msg = f.message ? `

${fence(f.message.split(`
`).slice(0, 8).join(`
`), "  ")}` : "";
      return `- **${md(f.id)}** (${md(where)})${msg}`;
    });
    details.push(`<details><summary>Failures (${failures.length}${r.run.tests.failuresTruncated ? "+" : ""})</summary>

${rows.join(`
`)}

</details>
`);
  }
  if (cov) {
    details.push(missedFiles(cov).join(`
`));
    const tables = [
      ...Object.keys(cov.components).length > 1 ? breakdown("Component", cov.components, c?.baseCoverage?.components) : [],
      ...breakdown("Flag", cov.flags, c?.baseCoverage?.flags)
    ];
    if (tables.length)
      details.push(`<details><summary>Coverage by component and flag</summary>

${tables.join(`
`)}
</details>
`);
  }
  if (r.run.uploads.length > 1 && t.total) {
    const rows = r.run.uploads.map((u) => {
      const f = u.tests.failed + u.tests.errored;
      return `| ${md(u.label)} | ${u.tests.passed} | ${f ? `**${f}**` : 0} | ${u.tests.skipped} | ${formatDuration(u.tests.durationMs)} | ${u.coverage ? formatPct(u.coverage.lines) : ""} |`;
    });
    details.push(`<details><summary>${plural(r.run.uploads.length, "job")}</summary>

| Job | Passed | Failed | Skipped | Time | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows.join(`
`)}

</details>
`);
  }
  out.push(...details);
  if (links.length)
    out.push(links.join(" · "), "");
  if (r.note)
    out.push(`> ${md(r.note)}`, "");
  let text = out.join(`
`).replace(/\n{3,}/g, `

`);
  if (text.length > COMMENT_MAX)
    text = `${text.slice(0, COMMENT_MAX)}

…cut short; the rest is in the dashboard.
`;
  return text;
}
function list2(title, ids) {
  const shown = ids.slice(0, 25).map((id) => `- ${md(id)}`);
  if (ids.length > 25)
    shown.push(`- …and ${ids.length - 25} more`);
  return `<details><summary>${title} (${ids.length})</summary>

${shown.join(`
`)}

</details>
`;
}

// src/post.ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function upsertComment(repo, pr, report, rules, opts) {
  const body = renderComment(report, rules);
  const prefix = markerPrefix(report.workflow);
  const mine = (await listComments(repo, pr, opts)).filter((c) => c.user?.type === "Bot" && c.body?.includes(prefix));
  const existing = mine[0];
  if (existing) {
    const last = markerRun(existing.body, report.workflow);
    if (last !== undefined && last > report.runId)
      return {
        action: "skipped",
        reason: `the comment is from a newer run (${last})`
      };
    const c = await updateComment(repo, existing.id, body, opts);
    return { action: "updated", url: c.html_url };
  }
  const c = await createComment(repo, pr, body, opts);
  return { action: "created", url: c.html_url };
}
async function postStatuses(repo, sha, results, targetUrl, opts) {
  const updates = statusesFor(results);
  for (const s of updates)
    await createStatus(repo, sha, { ...s, ...targetUrl ? { target_url: targetUrl } : {} }, opts);
  return updates.length;
}
async function uploadReport(report, retentionDays = 7) {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    warning("No Actions runtime token, so the report artifact was not uploaded.");
    return false;
  }
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "standalone-stats-report-"));
  try {
    const file = join(dir, REPORT_FILE);
    await writeFile(file, JSON.stringify(report));
    await new DefaultArtifactClient().uploadArtifact(REPORT_ARTIFACT, [file], dir, { retentionDays });
    return true;
  } catch (err) {
    warning(`Could not upload the report artifact: ${err.message}`);
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
async function downloadReport(findBy) {
  const client = new DefaultArtifactClient;
  const opts = findBy ? { findBy } : {};
  const { artifacts } = await client.listArtifacts({ latest: true, ...opts });
  const a = artifacts.find((x) => x.name === REPORT_ARTIFACT);
  if (!a)
    return;
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "standalone-stats-report-dl-"));
  try {
    await client.downloadArtifact(a.id, { path: dir, ...opts });
    if (!(await readdir(dir)).includes(REPORT_FILE))
      throw new Error(`artifact ${REPORT_ARTIFACT} has no ${REPORT_FILE}`);
    return await readFile(join(dir, REPORT_FILE), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { patchCoverage, parseRepo, getRepo, getPages, createRepo, enablePages, defaultPagesUrl, compareDiff, PermissionError, getRun, getPull, renderSummary, parseThresholds, evaluate, failedRules, buildReport, sanitizeReport, thresholdLine, upsertComment, postStatuses, uploadReport, downloadReport };
