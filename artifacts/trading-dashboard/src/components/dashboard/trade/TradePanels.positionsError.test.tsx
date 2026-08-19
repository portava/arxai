// P0-3 (second site) — the Trade Command Room "Positions" tab must not read as
// "flat" when the positions fetch fails.
//
// `pages/trade-command-room.tsx` passed `positionsQ.data?.rows ?? []` straight
// into this panel. On a failed or in-flight read that is an empty array, and
// the panel rendered "No open positions" — the same wrong-trading-decision
// illusion as OpenLivePositions, on a different page.
//
// Contract locked here: loading and error resolve BEFORE the empty state, so
// "No open positions" can only render on a successful read.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// wouter's <Link> is used by the panel's empty-state buttons; render it as a
// plain anchor so no Router is required.
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { PositionsPanel } from "./TradePanels";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PositionsPanel — a failed positions read must never read as 'flat'", () => {
  it("renders the error state, NOT 'No open positions', when isError", () => {
    render(<PositionsPanel positions={[]} isError onRetry={() => {}} />);

    const err = screen.getByTestId("positions-error");
    expect(err).toBeTruthy();
    expect(screen.queryByTestId("positions-loading")).toBeNull();
    // The decisive assertion.
    expect(screen.queryByText(/No open positions/i)).toBeNull();
    expect(err.textContent ?? "").toMatch(/do not assume you are flat/i);
  });

  it("offers a retry that calls back", () => {
    const onRetry = vi.fn();
    render(<PositionsPanel positions={[]} isError onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId("btn-retry-positions"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state — never the empty state — while in flight", () => {
    render(<PositionsPanel positions={[]} isLoading />);

    expect(screen.getByTestId("positions-loading")).toBeTruthy();
    expect(screen.queryByText(/No open positions/i)).toBeNull();
    expect(screen.queryByTestId("positions-error")).toBeNull();
  });

  it("renders the empty state ONLY on a settled, successful read", () => {
    render(<PositionsPanel positions={[]} />);

    expect(screen.getByText(/No open positions/i)).toBeTruthy();
    expect(screen.queryByTestId("positions-error")).toBeNull();
    expect(screen.queryByTestId("positions-loading")).toBeNull();
  });

  it("renders rows when positions are present", () => {
    render(
      <PositionsPanel
        positions={[{ id: 7, symbol: "EURUSD", side: "BUY", lotSize: 0.1, entry: 1.1, pnl: 12.34 }]}
      />,
    );

    expect(screen.getByTestId("position-7")).toBeTruthy();
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.queryByText(/No open positions/i)).toBeNull();
    expect(screen.queryByTestId("positions-error")).toBeNull();
  });
});
