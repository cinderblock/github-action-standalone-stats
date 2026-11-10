import { Suspense, use, useMemo } from 'react';
import type { DetailFile, IndexEntry } from '../../../src/model.js';
import {
  Empty,
  ErrorBoundary,
  Loading,
  Meter,
  Time,
} from '../components/ui.js';
import { getDetailIfKept, getIndex, getRun } from '../lib/data.js';
import {
  detailFlags,
  listDir,
  mergeDetail,
  totalsByFile,
  type Coverage as Cov,
} from '../lib/coverage.js';
import { fmtInt, fmtPct, pctOf, shortSha } from '../lib/format.js';
import { href, navigate, useRoute } from '../lib/router.js';
import { mainBranch, repoUrl } from '../lib/runs.js';
import { totals } from '../../../src/coverage/model.js';
import { CoverageFile } from './CoverageFile.js';

/** Merged coverage per detail file and flag selection, so moving around the
 *  tree doesn't re-merge. */
const merged = new WeakMap<
  DetailFile,
  Map<string, { cov: Cov; byFile: ReturnType<typeof totalsByFile> }>
>();
export function mergedFor(detail: DetailFile, flags: string[]) {
  let m = merged.get(detail);
  if (!m) merged.set(detail, (m = new Map()));
  const k = flags.join('\n');
  let v = m.get(k);
  if (!v) {
    const cov = mergeDetail(detail, flags);
    v = { cov, byFile: totalsByFile(cov) };
    m.set(k, v);
  }
  return v;
}

export function parseFlags(q: URLSearchParams): string[] {
  return (q.get('flags') ?? '').split(',').filter(Boolean).sort();
}

/** `#/coverage[/<runKey>[/file/<path>]]` */
export function Coverage({ parts }: { parts: string[] }) {
  const index = use(getIndex());
  const covRuns = index.runs.filter(r => r.coverage);
  let key = parts[0];
  if (!key) {
    const main = mainBranch(index.runs);
    key = (covRuns.filter(r => r.branch === main).at(-1) ?? covRuns.at(-1))
      ?.key;
  }
  const entry = covRuns.find(r => r.key === key);
  if (!entry)
    return (
      <Empty>
        {key ? `Run ${key} has no coverage stored.` : 'No coverage stored yet.'}
      </Empty>
    );
  const file = parts[1] === 'file' ? parts.slice(2).join('/') : undefined;

  return (
    <ErrorBoundary resetKey={entry.key}>
      <Suspense fallback={<Loading />}>
        <WithDetail entry={entry} covRuns={covRuns} file={file} />
      </Suspense>
    </ErrorBoundary>
  );
}

function WithDetail({
  entry,
  covRuns,
  file,
}: {
  entry: IndexEntry;
  covRuns: IndexEntry[];
  file: string | undefined;
}) {
  const rec = use(getRun(entry.path));
  const detail = use(getDetailIfKept(rec.coverage!.detail));
  const route = useRoute();
  const flags = parseFlags(route.query);
  const index = use(getIndex());

  const header = (
    <>
      <h1 className="page-title">Coverage</h1>
      <p className="lede">
        <a href={href(['runs', entry.key])}>
          <code>{shortSha(entry.sha)}</code> on {entry.branch ?? '?'}
        </a>
        , <Time iso={entry.time} />
      </p>
      <RunPicker covRuns={covRuns} value={entry.key} />
    </>
  );

  if (!detail)
    return (
      <>
        {header}
        <Empty>
          Line detail for this run has been pruned (only the newest runs keep
          it; see the <code>detail-window</code> input). Its totals are on the{' '}
          <a href={href(['runs', entry.key])}>run page</a>.
        </Empty>
      </>
    );

  const all = detailFlags(detail);
  const sel = flags.filter(f => all.includes(f));
  const { cov, byFile } = mergedFor(detail, sel);
  const flagLink = (next: string[]) =>
    href(
      file ? ['coverage', entry.key, 'file', file] : ['coverage', entry.key],
      {
        path: route.query.get('path') ?? undefined,
        flags: next.join(',') || undefined,
      },
    );

  return (
    <>
      {header}
      {all.length > 1 && (
        <div className="filters">
          <div className="field">
            <span>Flags</span>
            <div className="chips" role="group" aria-label="Flags">
              <a
                className={`chip toggle ${sel.length ? '' : 'on'}`}
                href={flagLink([])}
                aria-pressed={!sel.length}
              >
                All
              </a>
              {all.map(f => {
                const on = sel.includes(f);
                return (
                  <a
                    key={f}
                    className={`chip toggle ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    href={flagLink(
                      on ? sel.filter(x => x !== f) : [...sel, f].sort(),
                    )}
                  >
                    {f}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {file ? (
        <CoverageFile
          repo={index.repo}
          web={repoUrl(index)}
          sha={detail.sha}
          path={file}
          cov={cov}
          back={href(['coverage', entry.key], {
            path: file.includes('/')
              ? file.slice(0, file.lastIndexOf('/'))
              : undefined,
            flags: sel.join(',') || undefined,
          })}
        />
      ) : (
        <Tree
          cov={cov}
          byFile={byFile}
          runKey={entry.key}
          flags={sel}
          dir={route.query.get('path') ?? ''}
        />
      )}
    </>
  );
}

function RunPicker({
  covRuns,
  value,
}: {
  covRuns: IndexEntry[];
  value: string;
}) {
  const recent = covRuns.slice(-50).reverse();
  if (recent.length < 2) return null;
  return (
    <div className="filters">
      <label className="field">
        <span>Run</span>
        <select
          value={value}
          onChange={e => navigate(href(['coverage', e.target.value]))}
        >
          {recent.map(r => (
            <option key={r.key} value={r.key}>
              {shortSha(r.sha)} · {r.branch ?? '?'} ·{' '}
              {fmtPct(pctOf(r.coverage!.l), 2)} ·{' '}
              {new Date(r.time).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </option>
          ))}
          {!recent.some(r => r.key === value) && (
            <option value={value}>{value}</option>
          )}
        </select>
      </label>
    </div>
  );
}

function Tree({
  cov,
  byFile,
  runKey,
  flags,
  dir,
}: {
  cov: Cov;
  byFile: ReturnType<typeof totalsByFile>;
  runKey: string;
  flags: string[];
  dir: string;
}) {
  const entries = useMemo(() => listDir(cov, byFile, dir), [cov, byFile, dir]);
  const here = useMemo(
    () => totals(cov, p => !dir || p.startsWith(`${dir}/`)),
    [cov, dir],
  );
  const f = flags.join(',') || undefined;
  const crumbs = dir ? dir.split('/') : [];

  return (
    <section>
      <nav className="crumbs" aria-label="Directory">
        <a href={href(['coverage', runKey], { flags: f })}>All files</a>
        {crumbs.map((c, i) => (
          <span key={i}>
            {' / '}
            {i === crumbs.length - 1 ? (
              <b>{c}</b>
            ) : (
              <a
                href={href(['coverage', runKey], {
                  path: crumbs.slice(0, i + 1).join('/'),
                  flags: f,
                })}
              >
                {c}
              </a>
            )}
          </span>
        ))}
      </nav>
      <p className="muted">
        {fmtPct(pctOf(here.lines), 2)} of lines ({fmtInt(here.lines.hit)}/
        {fmtInt(here.lines.total)})
        {here.branches.total > 0 && (
          <>, {fmtPct(pctOf(here.branches), 2)} of branches</>
        )}{' '}
        in {fmtInt(here.files)} files.
      </p>
      {entries.length ? (
        <div className="scroll">
          <table className="tree">
            <thead>
              <tr>
                <th>Name</th>
                <th className="n">Lines</th>
                <th className="n">Missed</th>
                <th className="n">Branches</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.path}>
                  <td className="path">
                    <a
                      href={
                        e.dir
                          ? href(['coverage', runKey], {
                              path: e.path,
                              flags: f,
                            })
                          : href(['coverage', runKey, 'file', e.path], {
                              flags: f,
                            })
                      }
                    >
                      {e.dir ? `${e.name}/` : e.name}
                    </a>
                    {e.dir && (
                      <span className="muted small">
                        {' '}
                        {fmtInt(e.files)} files
                      </span>
                    )}
                  </td>
                  <td className="n">
                    <Meter r={e.totals.lines} digits={2} />
                  </td>
                  <td className="n">
                    {fmtInt(e.totals.lines.total - e.totals.lines.hit)}
                  </td>
                  <td className="n">
                    {e.totals.branches.total
                      ? `${fmtPct(pctOf(e.totals.branches), 1)} (${e.totals.branches.hit}/${e.totals.branches.total})`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nothing here{flags.length ? ' for these flags' : ''}.</Empty>
      )}
    </section>
  );
}
