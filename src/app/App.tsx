import { useEffect, useRef } from 'react';
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router';
import { TaskView } from '../features/views/TaskView';
import { PwaStatus } from './PwaStatus';

function RouteFocus() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);

  useEffect(() => {
    const heading = document.querySelector<HTMLHeadingElement>('main h1');
    document.title = `${heading?.textContent ?? 'Taskmaster'} · Taskmaster`;
    if (previousPath.current !== pathname) {
      heading?.focus();
      previousPath.current = pathname;
    }
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-8">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-6 sm:py-8">
        <Link
          to="/list"
          aria-label="Taskmaster home"
          className="inline-flex min-h-11 items-center gap-3 text-lg font-semibold tracking-tight"
        >
          <span aria-hidden="true" className="text-accent">
            &gt;_
          </span>
          taskmaster
        </Link>
        <span className="text-xs text-muted">A little less noise.</span>
      </header>
      <div className="flex flex-1 flex-col gap-5 py-6 md:flex-row md:gap-8 md:py-8">
        <nav aria-label="Primary" className="shrink-0 md:w-44">
          <p className="mb-3 hidden px-3 text-xs uppercase tracking-widest text-muted md:block">
            Views
          </p>
          <ul className="grid grid-cols-3 gap-1 md:grid-cols-1">
            {[
              { path: '/categories', label: 'Categories' },
              { path: '/date', label: 'Date' },
              { path: '/list', label: 'Big List' },
            ].map(({ path, label }) => (
              <li key={path}>
                <NavLink to={path} className="nav-link">
                  <span aria-hidden="true" className="nav-marker">
                    &gt;
                  </span>
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 flex-1 self-stretch wrap-anywhere rounded-sm border border-line bg-panel"
        >
          <Routes>
            <Route path="/" element={<Navigate to="/list" replace />} />
            <Route path="/list" element={<TaskView kind="list" />} />
            <Route
              path="/categories"
              element={<TaskView kind="categories" />}
            />
            <Route path="/date" element={<TaskView kind="date" />} />
            <Route
              path="*"
              element={
                <div className="p-8">
                  <h1 tabIndex={-1} className="view-heading text-xl">
                    View not found
                  </h1>
                  <p className="my-4 text-muted">
                    This address doesn’t lead to a Taskmaster view.
                  </p>
                  <Link className="action inline-flex" to="/list">
                    Open Big List
                  </Link>
                </div>
              }
            />
          </Routes>
          <RouteFocus />
          <PwaStatus />
        </main>
      </div>
      <footer className="border-t border-line py-5 text-xs leading-6 text-muted">
        Local task preview · Cloud sync is not available yet.
      </footer>
    </div>
  );
}
