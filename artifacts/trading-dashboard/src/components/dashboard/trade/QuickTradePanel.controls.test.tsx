// Quick Trade (Trade Command Room): the "Risk check" and "Safety gates"
// switches were page-local state that nothing read — flipping them off changed
// no server check. They must not be shown as protections the trader can turn
// on or off; the panel says the server runs them on every submit instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("wouter", () => ({ useLocation: () => ["/trade-command-room", vi.fn()] }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));

const { QuickTradePanel } = await import("./QuickTradePanel");

afterEach(cleanup);

const noop = () => undefined;
function panel() {
  return (
    <QuickTradePanel
      symbol="EURUSD" setSymbol={noop} timeframe="M15" setTimeframe={noop}
      orderType="Market" setOrderType={noop} lot="0.01" setLot={noop} quote={null}
      slTpOn setSlTpOn={noop} stopLoss="" setStopLoss={noop} takeProfit="" setTakeProfit={noop}
      riskCheckOn={false} setRiskCheckOn={noop} safetyGatesOn={false} setSafetyGatesOn={noop}
      riskApprox="—" canTrade blockedLabel=""
    />
  );
}

describe("Quick Trade server-check controls", () => {
  it("no Risk check / Safety gates switch is rendered", () => {
    render(panel());
    expect(screen.queryByTestId("trade-riskcheck-toggle")).toBeNull();
    expect(screen.queryByTestId("trade-safety-toggle")).toBeNull();
  });

  it("says the server runs the checks on every submit and they cannot be turned off here", () => {
    render(panel());
    const note = screen.getByTestId("trade-server-checks-note").textContent ?? "";
    expect(note).toMatch(/server runs them on every order/i);
    expect(note).toMatch(/cannot be turned off/i);
  });
});
