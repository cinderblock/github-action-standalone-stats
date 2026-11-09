/**
 * Path normalization. Reports from different OSes and tools spell the same
 * file differently:
 *   nyc on Windows          SF:lib\darwin.ts
 *   OpenCppCoverage         <source>D:</source> + a\repo\repo\src\x.cpp
 *   gcovr                   src/x.cpp, <source>/home/runner/work/repo/repo
 * Everything is stored as a repo-relative POSIX path. This must run in the
 * job that produced the report, because only that job knows its workspace.
 */

/** Convert backslashes, collapse duplicate slashes and `.` segments, and
 *  resolve `..` where possible. Keeps a leading drive (`d:`) or `/`. */
export function toPosix(p: string): string {
  let s = p.replace(/\\/g, '/');
  // file:// URLs show up in some reporters: file:///home/x, file:///C:/x.
  if (/^file:\/\//i.test(s)) {
    s = decodeURIComponent(s.replace(/^file:\/\//i, ''));
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  }
  const drive = /^[a-zA-Z]:/.exec(s)?.[0];
  if (drive) s = s.slice(2);
  const absolute = s.startsWith('/');
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  const body = out.join('/');
  return `${drive ? drive.toLowerCase() : ''}${absolute ? '/' : ''}${body}`;
}

function sameFs(a: string, b: string, caseInsensitive: boolean) {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Make `file` relative to `workspace`. `bases` are extra roots the report
 * declared (Cobertura `<source>`), tried in order. Returns the normalized
 * path unchanged (minus any leading `/`) if no base matches; it was then
 * probably relative already.
 */
export function relativize(
  file: string,
  workspace: string,
  bases: string[] = [],
): string {
  const ws = toPosix(workspace);
  // Windows workspaces are case-insensitive; compare that way when either
  // side has a drive letter.
  const ci = /^[a-z]:/.test(ws) || /^[a-zA-Z]:/.test(file);

  const tryStrip = (abs: string, root: string): string | undefined => {
    if (!root) return undefined;
    const r = root.endsWith('/') ? root : `${root}/`;
    if (abs.length > r.length && sameFs(abs.slice(0, r.length), r, ci))
      return abs.slice(r.length);
    if (sameFs(abs, root, ci)) return '';
    return undefined;
  };

  const f = toPosix(file);
  const direct = tryStrip(f, ws);
  if (direct !== undefined) return direct;

  for (const base of bases) {
    const b = toPosix(base);
    // A relative file under a declared base: join, then strip the workspace.
    const joined = isAbsolute(f) ? f : toPosix(`${b}/${f}`);
    const stripped = tryStrip(joined, ws);
    if (stripped !== undefined) return stripped;
  }

  // OpenCppCoverage writes `<source>D:</source>` and files relative to the
  // drive root without the leading slash: `a\repo\repo\src\x.cpp`. Retry the
  // workspace with its drive and leading slash removed.
  const wsNoDrive = ws.replace(/^[a-z]:/, '').replace(/^\//, '');
  const noDrive = tryStrip(
    f.replace(/^[a-z]:/, '').replace(/^\//, ''),
    wsNoDrive,
  );
  if (noDrive !== undefined) return noDrive;

  return f.replace(/^[a-z]:/, '').replace(/^\/+/, '');
}

/**
 * Resolve a file named in a coverage report to a workspace-relative path,
 * or `undefined` when it's outside the workspace (system headers,
 * dependencies). Relative names are tried under each declared base
 * (Cobertura `<source>`), preferring one that `exists`; with no base they're
 * taken as already repo-relative.
 */
export function workspaceRelative(
  file: string,
  workspace: string,
  bases: string[] = [],
  exists?: (absolute: string) => boolean,
): string | undefined {
  const ws = toPosix(workspace);
  const ci = /^[a-z]:/.test(ws) || /^[a-zA-Z]:/.test(file);
  const strip = (abs: string): string | undefined => {
    const r = ws.endsWith('/') ? ws : `${ws}/`;
    if (abs.length > r.length && sameFs(abs.slice(0, r.length), r, ci))
      return abs.slice(r.length);
    return undefined;
  };
  const f = toPosix(file);
  if (isAbsolute(f)) return strip(f);
  if (!bases.length) return f || undefined;

  const candidates = bases.map(b => toPosix(`${b.replace(/[\\/]+$/, '')}/${f}`));
  const ordered = exists
    ? [
        ...candidates.filter(c => exists(c)),
        ...candidates.filter(c => !exists(c)),
      ]
    : candidates;
  for (const c of ordered) {
    if (!isAbsolute(c)) return c;
    const rel = strip(c);
    if (rel !== undefined) return rel;
  }
  return undefined;
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:/.test(p);
}
