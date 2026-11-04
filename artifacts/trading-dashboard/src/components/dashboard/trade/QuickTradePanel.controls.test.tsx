// Quick Trade (Trade Command Room): the "Risk check" and "Safety gates"
// switches were page-local state that nothing read — flipping them off changed
// no server check. They must not be shown as protections the trader can turn
// on or off; the panel says the server runs them on every submit instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("wouter", () => ({ useLocation: () => ["/trade-command-room", vi.fn()] }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ({ mode: { on: false, scope: "live", defaultVolume: 0.01, maxLotPerClick: null, canEnable: true, blockReason: null, loading: false }, busyKey: null, execute: vi.fn(), closePosition: vi.fn() }) }));
vi.mock("@/hooks/useSymbolLotSpec", () => ({ useSymbolLotSpec: () => ({ volumeMin: null, volumeStep: null, volumeMax: null, point: null, stopsLevel: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

describe("Quick Trade ticket handoff", () => {
  it("one-click OFF: SELL/BUY open the order window with the panel's settings (no order on the click)", () => {
    render(panel());
    expect(document.body.textContent).not.toMatch(/Execute a trade in seconds/);
    const note = screen.getByTestId("trade-ticket-handoff-note").textContent ?? "";
    expect(note).toMatch(/SELL and BUY open the order window for EURUSD/);
    expect(note).toMatch(/its button sends the order/);
    // The MT5-style order window (Buy/Sell Limit, Buy/Sell Stop, Stop Limit, SL/TP, expiry).
    expect(screen.getByTestId("order-ticket-open").textContent).toMatch(/Open order window/);
  });

  it("there is no Cancel button that opens the ticket", () => {
    render(panel());
    expect(screen.queryByTestId("trade-action-cancel")).toBeNull();
  });
});
