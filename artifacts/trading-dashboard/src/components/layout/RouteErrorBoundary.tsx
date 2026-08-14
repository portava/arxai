import React from "react";
import { useLocation } from "wouter";

// T007 — Route-level error boundary. A render crash in any single page
// (e.g. an unguarded `.length` on undefined we have not patched yet)
// must NOT take down the whole shell — sidebar, mode banner, and other
// routes have to keep working so the user can navigate away. This
// renders a calm, user-safe recovery card and a "Reload page" button.
// No raw error message is shown to normal users; the error is logged
// to the console for developers.
//
// The exported wrapper keys the boundary on the current wouter location,
// so navigating to a different route automatically clears stale error
// state (otherwise a user that crashed `/audit-log` would still see the
// error card after clicking `/dashboard`).

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

class RouteErrorBoundaryInner extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[RouteErrorBoundary] page render failed", error, info);
  }

  reset = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        className="max-w-xl mx-auto mt-12 rounded-lg border border-border bg-card p-6 space-y-3 text-center"
        data-testid="route-error-boundary"
        role="alert"
      >
        <h2 className="text-lg font-semibold">This page hit a snag.</h2>
        <p className="text-sm text-muted-foreground">
          Something on this page failed to render. Your data is safe and no
          trades were affected. You can try again or navigate to another page
          from the menu.
        </p>
        <div className="flex gap-2 justify-center pt-2">
          <button
            type="button"
            onClick={this.reset}
            className="px-3 py-1.5 rounded text-sm border border-border hover:bg-muted"
            data-testid="button-retry-page"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:opacity-90"
            data-testid="button-reload-page"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export function RouteErrorBoundary({ children }: Props): React.ReactElement {
  const [location] = useLocation();
  // The key ensures the boundary unmounts/remounts when the user
  // navigates, clearing any previous `hasError` state.
  return (
    <RouteErrorBoundaryInner key={location}>{children}</RouteErrorBoundaryInner>
  );
}
