import { Component } from 'react';
import type { ReactNode } from 'react';

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="mx-auto max-w-2xl px-6 py-16">
          <h1 className="text-xl text-white">
            Taskmaster couldn’t open this view.
          </h1>
          <p className="mt-4 text-muted">
            Reload the application to try again.
          </p>
          <a className="action mt-6 inline-flex" href="/list">
            Reload Taskmaster
          </a>
        </main>
      );
    }
    return this.props.children;
  }
}
