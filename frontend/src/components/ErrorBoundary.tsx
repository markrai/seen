import React, { Component, ErrorInfo, ReactNode } from 'react';

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  error: Error | null;
};

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep this noisy log only in dev; in production this can be wired to telemetry later.
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.error('Unhandled UI error:', error, info);
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-zinc-50 dark:bg-zinc-950">
        <div className="max-w-xl w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-lg font-semibold">Seen hit an unexpected UI error</div>
          <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            This shouldn’t happen. The app can usually recover by reloading.
          </div>
          <pre className="mt-3 text-xs overflow-auto max-h-48 rounded bg-zinc-100 dark:bg-zinc-950 p-3 text-zinc-800 dark:text-zinc-200">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm"
              onClick={() => this.setState({ error: null })}
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export { ErrorBoundary };
export default ErrorBoundary;

