import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CanonicalBalancePanel } from "./CanonicalBalancePanel";
import type { InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";
afterEach(cleanup);
const live: InvestorLiveBalance = { source: "live_shared", allocatedBalance: 1000, realizedPnL: 0,
  floatingPnL: 100, liveEquity: 1100, marginUsed: 0, freeMargin: 1100, availableBalance: 1000,
  openTradeCount: 0, freshness: { status: "fresh", ageMs: 0, lastUpdatedAt: new Date().toISOString() } };
describe("canonical balance presentation", () => {
  it("unknown counts stay unknown instead of reporting no trades", () => {
    render(<CanonicalBalancePanel live={null} />);
    expect(screen.getByText("Open trades").parentElement?.textContent).toBe("Open trades—");
  });
  it("a confirmed zero count is still shown as zero", () => {
    render(<CanonicalBalancePanel live={live} />);
    expect(screen.getByText("Open trades").parentElement?.textContent).toBe("Open trades0");
  });
  it("paused updates label the retained amount last-known", () => {
    render(<CanonicalBalancePanel live={live} updatesPaused />);
    expect(screen.getByText("Last-known equity").parentElement?.textContent).toContain("$1,100.00");
    expect(screen.queryByText("Live equity")).toBeNull();
    expect(screen.getByTestId("canonical-balance-paused-note").textContent).toContain("Refresh checks them once");
  });
  it("expired funds stay visible with their stale warning", () => {
    render(<CanonicalBalancePanel live={{...live, freshness: {...live.freshness, status:"stale"}}} />);
    expect(screen.queryByText("Live equity")).toBeNull();
    expect(screen.getByTestId("canonical-balance-stale-note").textContent).toContain("last known");
  });
});
