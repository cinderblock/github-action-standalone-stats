import { Suspense, use, useMemo } from 'react';
import { fileTotals } from '../../../src/coverage/model.js';
import { Empty, Loading, Meter } from '../components/ui.js';
import {
  lineViews,
  missRanges,
  type Coverage,
  type LineView,
} from '../lib/coverage.js';
import { getSource } from '../lib/data.js';
import { fmtInt, fmtPct, pctOf } from '../lib/format.js';

const MARK = { hit: '✓', miss: '✕', partial: '◐', none: '' } as const;
const STATE_LABEL = {
  hit: 'covered',
  miss: 'not covered',
  partial: 'partly covered',
  none: '',
} as const;

export function CoverageFile({
  repo,
  web,
  sha,
  path,
  cov,
  back,
}: {
  repo: string;
  /** Repo web URL, for the "on GitHub" link. */
  web: string;
  sha: string;
  path: string;
  cov: Coverage;
  back: string;
}) {
  const file = cov.get(path);
  if (!file)
    return (
      <Empty>
        No coverage for <code>{path}</code> with these flags.{' '}
        <a href={back}>Back</a>
      </Empty>
    );
  const t = fileTotals(file);
  return (
    <section>
      <nav className="crumbs">
        <a href={back}>← Directory</a>
      </nav>
      <h2 className="path">{path}</h2>
      <p className="muted">
        <Meter r={t.lines} digits={2} /> {fmtInt(t.lines.hit)} of{' '}
        {fmtInt(t.lines.total)} lines
        {t.branches.total > 0 && (
          <>
            , {fmtPct(pctOf(t.branches), 1)} of branches ({t.branches.hit}/
            {t.branches.total})
          </>
        )}{' '}
        · <a href={`${web}/blob/${sha}/${path}`}>on GitHub</a>
      </p>
      <Suspense fallback={<Loading />}>
        <Lines repo={repo} sha={sha} path={path} file={file} />
      </Suspense>
    </section>
  );
}

function Lines({
  repo,
  sha,
  path,
  file,
}: {
  repo: string;
  sha: string;
  path: string;
  file: NonNullable<ReturnType<Coverage['get']>>;
}) {
  const src = use(getSource(repo, sha, path));
  const lines = useMemo(() => lineViews(file, src?.length ?? 0), [file, src]);
  const misses = useMemo(() => missRanges(lines, ['miss', 'partial']), [lines]);
  const jump = (n: number) =>
    document
      .getElementById(`L${n}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  return (
    <>
      {!src && (
        <p className="note">
          Source text isn’t available here (private repository, or the file
          moved), so lines show without it.
        </p>
      )}
      {misses.length > 0 && (
        <div className="jumps">
          <span className="muted small">Not fully covered:</span>
          {misses.slice(0, 60).map(([a, b]) => (
            <button key={a} className="chip" onClick={() => jump(a)}>
              {a === b ? a : `${a}–${b}`}
            </button>
          ))}
          {misses.length > 60 && (
            <span className="muted small">…{misses.length - 60} more</span>
          )}
        </div>
      )}
      <div className="legend">
        <span>
          <span className="lk hit">{MARK.hit}</span> covered
        </span>
        <span>
          <span className="lk partial">{MARK.partial}</span> some branches not
          taken
        </span>
        <span>
          <span className="lk miss">{MARK.miss}</span> not covered
        </span>
      </div>
      <div className="source" role="table" aria-label={`Coverage of ${path}`}>
        {lines.map(l => (
          <Line key={l.n} l={l} text={src?.[l.n - 1]} />
        ))}
      </div>
    </>
  );
}

function Line({ l, text }: { l: LineView; text: string | undefined }) {
  return (
    <div className={`ln ${l.state}`} id={`L${l.n}`} role="row">
      <span className="ln-n" role="cell">
        {l.n}
      </span>
      <span className="ln-mark" role="cell" aria-label={STATE_LABEL[l.state]}>
        {MARK[l.state]}
      </span>
      <span className="ln-hits" role="cell">
        {l.hits !== undefined ? `${fmtInt(l.hits)}×` : ''}
        {l.br && (
          <span className="ln-br">
            {' '}
            {l.br[0]}/{l.br[1]}
          </span>
        )}
      </span>
      <code className="ln-src" role="cell">
        {text ?? ''}
      </code>
    </div>
  );
}
