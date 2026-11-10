import { use, useState } from 'react';
import { BranchPicker } from '../components/BranchPicker.js';
import { RunsTable } from '../components/RunsTable.js';
import { Empty } from '../components/ui.js';
import { getIndex } from '../lib/data.js';
import { plural } from '../lib/format.js';
import { href, navigate, useRoute } from '../lib/router.js';
import { branchParam, failing, onBranch } from '../lib/runs.js';

const PAGE = 50;

export function Runs() {
  const index = use(getIndex());
  const route = useRoute();
  // The run list shows every branch unless one is picked.
  const branch = branchParam(route.query, undefined);
  const event = route.query.get('event') ?? '';
  const onlyFailing = route.query.get('failing') === '1';
  const [shown, setShown] = useState(PAGE);

  const events = [...new Set(index.runs.map(r => r.event))].sort();
  const runs = onBranch(index.runs, branch)
    .filter(r => !event || r.event === event)
    .filter(r => !onlyFailing || failing(r) > 0)
    .reverse();

  const set = (k: string, v: string | undefined) => {
    const q = Object.fromEntries(route.query);
    q[k] = v ?? '';
    navigate(href(['runs'], q), true);
  };

  return (
    <>
      <h1 className="page-title">Runs</h1>
      <div className="filters">
        <BranchPicker
          runs={index.runs}
          value={branch}
          onChange={b => set('branch', b || undefined)}
        />
        {events.length > 1 && (
          <label className="field">
            <span>Event</span>
            <select value={event} onChange={e => set('event', e.target.value)}>
              <option value="">Any event</option>
              {events.map(e => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field check">
          <input
            type="checkbox"
            checked={onlyFailing}
            onChange={e => set('failing', e.target.checked ? '1' : undefined)}
          />
          <span>Only runs with failures</span>
        </label>
      </div>
      <p className="muted">{plural(runs.length, 'run')}</p>
      {runs.length ? (
        <>
          <RunsTable runs={runs.slice(0, shown)} />
          {runs.length > shown && (
            <button className="more" onClick={() => setShown(s => s + PAGE)}>
              Show {Math.min(PAGE, runs.length - shown)} more
            </button>
          )}
        </>
      ) : (
        <Empty>No runs match.</Empty>
      )}
    </>
  );
}
