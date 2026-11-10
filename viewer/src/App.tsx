import { Suspense, use, useEffect } from 'react';
import { ErrorBoundary, Loading } from './components/ui.js';
import { getIndex } from './lib/data.js';
import { href, useRoute } from './lib/router.js';
import { repoUrl } from './lib/runs.js';
import { Coverage } from './pages/Coverage.js';
import { Overview } from './pages/Overview.js';
import { Run } from './pages/Run.js';
import { Runs } from './pages/Runs.js';
import { Test } from './pages/Test.js';
import { Tests } from './pages/Tests.js';

const NAV = [
  ['', 'Overview'],
  ['runs', 'Runs'],
  ['tests', 'Tests'],
  ['coverage', 'Coverage'],
] as const;

export function App() {
  const route = useRoute();
  const [top = ''] = route.parts;
  const section = top === 'test' ? 'tests' : top;
  const routeKey = location.hash;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.parts.join('/')]);

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <ErrorBoundary>
            <Suspense fallback={<span className="brand">Stats</span>}>
              <Brand />
            </Suspense>
          </ErrorBoundary>
          <nav className="nav" aria-label="Sections">
            {NAV.map(([k, label]) => (
              <a
                key={k}
                href={href(k ? [k] : [])}
                aria-current={section === k ? 'page' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main>
        <ErrorBoundary resetKey={routeKey}>
          <Suspense fallback={<Loading />}>
            <Page parts={route.parts} query={route.query} />
          </Suspense>
        </ErrorBoundary>
      </main>
      <footer className="foot muted small">
        <a href="https://github.com/cinderblock/github-action-standalone-stats">
          standalone-stats
        </a>{' '}
        · <a href="data/index.json">raw data</a>
      </footer>
    </>
  );
}

function Brand() {
  const index = use(getIndex());
  useEffect(() => {
    document.title = `${index.repo} · stats`;
  }, [index.repo]);
  return (
    <a className="brand" href={repoUrl(index)}>
      {index.repo}
    </a>
  );
}

function Page({ parts, query }: { parts: string[]; query: URLSearchParams }) {
  const [top, ...rest] = parts;
  switch (top) {
    case undefined:
      return <Overview />;
    case 'runs':
      return rest[0] ? <Run runKey={rest[0]} /> : <Runs />;
    case 'tests':
      return <Tests />;
    case 'test':
      return <Test id={query.get('id') ?? ''} />;
    case 'coverage':
      return <Coverage parts={rest} />;
    default:
      return (
        <p className="empty">
          Nothing at this address. <a href="#/">Overview</a>
        </p>
      );
  }
}
