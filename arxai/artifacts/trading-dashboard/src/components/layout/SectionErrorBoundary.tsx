import React from "react";

// Section-level error boundary. Unlike RouteErrorBoundary (which wraps the
// whole page), this isolates a single widget/section so one failing component
// (e.g. the chart) degrades to a small inline notice instead of blanking the
// entire page. Safety-critical surfaces — trade controls, safety banners, the
// rest of the page — keep rendering. The raw error is logged to the console
// for developers; normal users never see a stack trace.

type Props = {
  children: React.ReactNode;
  /** Short human label for the section, e.g. "Chart" — used in the fallback copy. */
  section?: string;
};
type State = { hasError: boolean };

class SectionErrorBoundaryInner extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown): void {
    // eslint-disable-next-line no-console
    console.error(
      `[SectionErrorBoundary]${this.props.section ? ` ${this.props.section}` : ""} render failed`,
      error,
      info,
    );
  }

  reset = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        className="rounded-md border border-border bg-card/60 p-4 text-center text-sm text-muted-foreground"
        data-testid="section-error-boundary"
        role="alert"
      >
        <p className="font-medium text-foreground">
          {this.props.section ? `${this.props.section} couldn't load.` : "This section couldn't load."}
        </p>
        <p className="mt-1 text-xs">
          The rest of the page is unaffected and no trades were impacted.
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-3 rounded border border-border px-3 py-1 text-xs hover:bg-muted"
          data-testid="section-error-retry"
        >
          Retry
        </button>
      </div>
    );
  }
}

export function SectionErrorBoundary({ children, section }: Props): React.ReactElement {
  return <SectionErrorBoundaryInner section={section}>{children}</SectionErrorBoundaryInner>;
}

export default SectionErrorBoundary;
