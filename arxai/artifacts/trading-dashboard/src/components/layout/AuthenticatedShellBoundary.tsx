import { Component, type ReactNode } from "react";

/** Above both lazy shell modules: Suspense handles loading, not rejected imports. */
export class AuthenticatedShellBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[AuthenticatedShellBoundary] workspace could not load", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto mt-16 max-w-xl rounded-lg border border-border bg-card p-6 text-center" role="alert" data-testid="authenticated-shell-error">
        <h1 className="text-lg font-semibold">Your workspace could not load.</h1>
        <p className="mt-2 text-sm text-muted-foreground">Check your connection, then reload to try again.</p>
        <button
          type="button"
          className="mt-5 rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90"
          data-testid="button-reload-workspace"
          // React.lazy caches a rejected import. A document reload creates a
          // fresh module loader instead of retrying the same cached rejection.
          onClick={() => window.location.reload()}
        >
          Reload workspace
        </button>
      </main>
    );
  }
}
