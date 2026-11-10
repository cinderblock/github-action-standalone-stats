import { use } from 'react';
import { DurationChart } from '../charts/DurationChart.js';
import { History } from '../components/History.js';
import { Empty, Tile } from '../components/ui.js';
import { getIndex, getTests } from '../lib/data.js';
import { fmtDuration, fmtInt } from '../lib/format.js';
import { href, navigate } from '../lib/router.js';
import { flips, median, STATUS_LABEL, type HistoryCode } from '../lib/tests.js';
import { HistoryKey } from './Tests.js';
import { Time } from '../components/ui.js';

export function Test({ id }: { id: string }) {
  const idx = use(getTests());
  const index = use(getIndex());
  const t = idx.tests[id];
  if (!t) return <Empty>Test “{id}” isn’t in the recent history.</Empty>;
  const byKey = new Map(index.runs.map(r => [r.key, r]));
  const points = idx.runs.map((key, i) => {
    const time = byKey.get(key)?.time;
    return {
      key,
      ...(time ? { time } : {}),
      ms: Math.max(0, t.d[i] ?? 0),
      status: (t.h[i] ?? '-') as HistoryCode,
    };
  });
  const ran = points.filter(p => p.status !== '-');
  const fails = ran.filter(p => p.status === 'f' || p.status === 'e');
  const recent = [...points]
    .reverse()
    .filter(p => p.status !== '-')
    .slice(0, 20);

  return (
    <>
      <h1 className="page-title">{t.name}</h1>
      <p className="lede">
        {t.suite}
        {t.file && (
          <>
            {' '}
            · <code>{t.file}</code>
          </>
        )}
      </p>
      <div className="tiles">
        <Tile
          label="Runs"
          value={fmtInt(ran.length)}
          note={`of the last ${idx.runs.length}`}
        />
        <Tile
          label="Failed"
          value={fmtInt(fails.length)}
          {...(fails.length ? { status: 'bad' as const } : {})}
        />
        <Tile label="Flips" value={fmtInt(flips(t.h))} note="pass ↔ fail" />
        <Tile label="Median time" value={fmtDuration(median(t.d))} />
      </div>
      <section>
        <h2>History</h2>
        <HistoryKey />
        <History h={t.h} max={500} />
      </section>
      <section>
        <h2>Duration</h2>
        <DurationChart
          points={points}
          onOpen={key => navigate(href(['runs', key]))}
        />
      </section>
      <section>
        <h2>Recent runs</h2>
        <ul className="list">
          {recent.map(p => (
            <li key={p.key}>
              <a href={href(['runs', p.key])}>
                {p.time ? <Time iso={p.time} /> : p.key}
              </a>{' '}
              <span className="muted">
                {STATUS_LABEL[p.status]} · {fmtDuration(p.ms)}
              </span>
            </li>
          ))}
        </ul>
        {fails.length > 0 && (
          <p className="muted small">
            Failure messages are on each run’s page.
          </p>
        )}
      </section>
    </>
  );
}
