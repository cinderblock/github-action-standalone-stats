import { use, useDeferredValue, useMemo, useState } from 'react';
import { History } from '../components/History.js';
import { Empty, StatusIcon } from '../components/ui.js';
import { getTests } from '../lib/data.js';
import { fmtDuration, fmtInt, plural } from '../lib/format.js';
import { href, navigate, useRoute } from '../lib/router.js';
import {
  sortTests,
  testRows,
  STATUS_LABEL,
  type TestSort,
} from '../lib/tests.js';

const PAGE = 100;
const SORTS: [TestSort, string][] = [
  ['failing', 'Failing first'],
  ['flaky', 'Flakiest'],
  ['slow', 'Slowest'],
  ['name', 'Name'],
];

export function Tests() {
  const idx = use(getTests());
  const route = useRoute();
  const sort = (route.query.get('sort') as TestSort | null) ?? 'failing';
  const [q, setQ] = useState(route.query.get('q') ?? '');
  const dq = useDeferredValue(q.trim().toLowerCase());
  const [shown, setShown] = useState(PAGE);

  const all = useMemo(() => testRows(idx), [idx]);
  const rows = useMemo(
    () =>
      sortTests(
        dq
          ? all.filter(r =>
              `${r.id} ${r.file ?? ''}`.toLowerCase().includes(dq),
            )
          : all,
        sort,
      ),
    [all, dq, sort],
  );

  return (
    <>
      <h1 className="page-title">Tests</h1>
      <p className="muted">
        {plural(all.length, 'test')} seen in the last{' '}
        {plural(idx.runs.length, 'run')}. History is oldest to newest; each mark
        is a run (worst result across jobs).
      </p>
      <div className="filters">
        <label className="field grow">
          <span>Search</span>
          <input
            type="search"
            value={q}
            placeholder="Name, suite or file"
            onChange={e => {
              setQ(e.target.value);
              setShown(PAGE);
            }}
          />
        </label>
        <label className="field">
          <span>Sort</span>
          <select
            value={sort}
            onChange={e =>
              navigate(
                href(['tests'], { sort: e.target.value, q: q || undefined }),
                true,
              )
            }
          >
            {SORTS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <HistoryKey />
      {rows.length ? (
        <div className="scroll">
          <table className="tests">
            <thead>
              <tr>
                <th>Test</th>
                <th>Last</th>
                <th>History</th>
                <th className="n">Failed</th>
                <th className="n">Flips</th>
                <th className="n">Median</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map(r => (
                <tr key={r.id}>
                  <td>
                    <a href={href(['test'], { id: r.id })}>{r.name}</a>
                    <div className="muted small">{r.suite}</div>
                  </td>
                  <td className="nowrap">
                    {(r.last === 'f' || r.last === 'e') && (
                      <StatusIcon status="bad" />
                    )}{' '}
                    {STATUS_LABEL[r.last]}
                  </td>
                  <td>
                    <History h={r.h} />
                  </td>
                  <td className="n">
                    {fmtInt(r.fails)}/{fmtInt(r.runs)}
                  </td>
                  <td className="n">{fmtInt(r.flips)}</td>
                  <td className="n">{fmtDuration(r.medianMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown && (
            <button className="more" onClick={() => setShown(s => s + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          )}
        </div>
      ) : (
        <Empty>No tests match.</Empty>
      )}
    </>
  );
}

export function HistoryKey() {
  return (
    <div className="legend">
      <span>
        <span className="h h-p" /> passed
      </span>
      <span>
        <span className="h h-f" /> failed
      </span>
      <span>
        <span className="h h-s" /> skipped
      </span>
      <span>
        <span className="h h-none" /> not run
      </span>
    </div>
  );
}
