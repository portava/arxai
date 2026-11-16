import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PnlCell } from "./PnlCell";

afterEach(() => cleanup());

/**
 * UI coverage for the "EA too old to report close fill — upgrade to v1.28"
 * nudge on the Trade Logs P/L cell. The nudge is rendered as
 * `data-testid="trade-ea-upgrade-hint-<id>"` and must:
 *   - show for closed trades with pnlStatus="UNKNOWN" closed by an EA that is
 *     null / older than v1.28,
 *   - be ABSENT for v1.28+ (boundary: major 1, minor < 28),
 *   - never appear when the P/L is trusted (pnlStatus !== "UNKNOWN").
 */
describe("PnlCell — EA upgrade nudge", () => {
  it("shows the nudge for an UNKNOWN-P/L trade with a null EA version", () => {
    render(<PnlCell id={101} pnlStatus="UNKNOWN" reportedEaVersion={null} />);
    expect(screen.getByTestId("trade-ea-upgrade-hint-101")).toBeTruthy();
    expect(screen.getByText("P/L unavailable")).toBeTruthy();
    expect(
      screen.getByText("upgrade to v1.28").getAttribute("href"),
    ).toBe("/mt5-setup");
  });

  it("shows the nudge for an UNKNOWN-P/L trade closed by EA v1.27", () => {
    render(<PnlCell id={102} pnlStatus="UNKNOWN" reportedEaVersion="1.27" />);
    expect(screen.getByTestId("trade-ea-upgrade-hint-102")).toBeTruthy();
  });

  it("hides the nudge for an UNKNOWN-P/L trade closed by EA v1.28 (boundary)", () => {
    render(<PnlCell id={103} pnlStatus="UNKNOWN" reportedEaVersion="1.28" />);
    expect(screen.queryByTestId("trade-ea-upgrade-hint-103")).toBeNull();
    // The P/L is still untrusted, so the row still says "unavailable".
    expect(screen.getByText("P/L unavailable")).toBeTruthy();
  });

  it("hides the nudge for newer EA versions (v1.29, v2.0)", () => {
    render(<PnlCell id={104} pnlStatus="UNKNOWN" reportedEaVersion="1.29" />);
    expect(screen.queryByTestId("trade-ea-upgrade-hint-104")).toBeNull();
    cleanup();
    render(<PnlCell id={105} pnlStatus="UNKNOWN" reportedEaVersion="2.0" />);
    expect(screen.queryByTestId("trade-ea-upgrade-hint-105")).toBeNull();
  });

  it("does not render the nudge for a trusted (non-UNKNOWN) P/L row", () => {
    render(
      <PnlCell id={106} pnlStatus="COMPUTED" pnl={-12.5} reportedEaVersion={null} />,
    );
    expect(screen.queryByTestId("trade-ea-upgrade-hint-106")).toBeNull();
    expect(screen.queryByText("P/L unavailable")).toBeNull();
  });

  it("only shows the reported-version diagnostic to operators", () => {
    const { rerender } = render(
      <PnlCell id={107} pnlStatus="UNKNOWN" reportedEaVersion="1.27" />,
    );
    expect(screen.queryByText(/reported v1\.27/)).toBeNull();
    rerender(
      <PnlCell
        id={107}
        pnlStatus="UNKNOWN"
        reportedEaVersion="1.27"
        shouldShowAdminDiagnostics
      />,
    );
    expect(screen.getByText(/reported v1\.27/)).toBeTruthy();
  });
});
