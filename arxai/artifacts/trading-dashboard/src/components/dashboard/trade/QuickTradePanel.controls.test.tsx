// Quick Trade (Trade Command Room): the "Risk check" and "Safety gates"
// switches were page-local state that nothing read — flipping them off changed
// no server check. They must not be shown as protections the trader can turn
// on or off; the panel says the server runs them on every submit instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("wouter", () => ({ useLocation: () => ["/trade-command-room", vi.fn()] }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));

// These tests own the quote/control contract; one-click state is explicit and no network is used.
const oneClick = vi.hoisted(() => ({ on: false, execute: vi.fn() }));
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ({
  mode: { on: oneClick.on, scope: "live", maxLotPerClick: null }, busyKey: null, execute: oneClick.execute,
}) }));
vi.mock("@/hooks/useSymbolLotSpec", () => ({ useSymbolLotSpec: () => ({ volumeMin: null, volumeStep: null, volumeMax: null }) }));
vi.mock("@/components/trade/OrderTicketOverlay", () => ({
  OrderTicketButton: () => <button>Open order window</button>,
  OrderTicketOverlay: ({ symbol, prefill }: { symbol: string; prefill: unknown }) => <div data-testid="ticket-prefill">{JSON.stringify({ symbol, prefill })}</div>,
}));

const { QuickTradePanel } = await import("./QuickTradePanel");

afterEach(() => { cleanup(); oneClick.on = false; oneClick.execute.mockReset(); });

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
  it("with one-click off, Buy opens a prefilled ticket without executing", () => {
    render(panel());
    expect(document.body.textContent).not.toMatch(/Execute a trade in seconds/);
    const note = screen.getByTestId("trade-ticket-handoff-note").textContent ?? "";
    expect(note).toMatch(/SELL and BUY open the order window for EURUSD/);
    expect(note).toMatch(/side, lot size, stop loss and take profit set here; its button sends the order/);
    fireEvent.click(screen.getByTestId("trade-action-buy"));
    expect(oneClick.execute).not.toHaveBeenCalled();
    expect(JSON.parse(screen.getByTestId("ticket-prefill").textContent!)).toEqual({
      symbol: "EURUSD", prefill: { orderType: "MARKET_BUY", lot: 0.01, stopLoss: null, takeProfit: null },
    });
  });

  it("with one-click on, explicitly warns that the first click sends the order", () => {
    oneClick.on = true;
    render(panel());
    expect(screen.getByTestId("trade-ticket-handoff-note").textContent).toMatch(/One-click is on: SELL and BUY send a market order for EURUSD on the first click/);
  });

  it("there is no Cancel button that opens the ticket", () => {
    render(panel());
    expect(screen.queryByTestId("trade-action-cancel")).toBeNull();
  });
});
