import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { PositionSideCard, type UnifiedPosition } from "./PositionSideCard";

/**
 * Truth guard for the live-chart position side card.
 * "Risk est." used |entry − SL| × lot × 100,000 with a "$" for EVERY symbol:
 * XAUUSD 1 lot 2380 → 2370 read "$1000000.00", USDJPY showed yen as dollars.
 */

vi.mock("./PositionMiniChart", () => ({ PositionMiniChart: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));

function pos(patch: Partial<UnifiedPosition>): UnifiedPosition {
  return {
    scope: "live",
    brokerTicket: "555",
    symbol: "EURUSD",
    side: "BUY",
    lotSize: 1,
    entryPrice: 1.1,
    currentPrice: 1.101,
    stopLoss: 1.099,
    takeProfit: 1.103,
    floatingPnl: 10,
    openedAt: new Date().toISOString(),
    sourceCommandId: null,
    accountMode: "LIVE",
    source: "MT5_LIVE_BRIDGE",
    ...patch,
  };
}

function mount(p: UnifiedPosition) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candles: [], feedStatus: null }), { status: 200 })));
  render(<PositionSideCard position={p} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PositionSideCard risk estimate", () => {
  it("does not guess a 100,000-unit contract for gold", () => {
    mount(pos({ symbol: "XAUUSD", entryPrice: 2380, stopLoss: 2370, lotSize: 1 }));
    const risk = screen.getByTestId("text-position-risk");
    expect(risk.textContent).not.toBe("$1000000.00");
    expect(risk.textContent).toBe("—");
    expect(risk.parentElement?.getAttribute("title") ?? "").toMatch(/Contract size for XAUUSD is not reported/);
  });

  it("does not guess a contract for a synthetic index", () => {
    mount(pos({ symbol: "Volatility 75 Index", entryPrice: 400000, stopLoss: 399000, lotSize: 0.01 }));
    expect(screen.getByTestId("text-position-risk").textContent).toBe("—");
  });

  it("states a JPY-quoted risk in JPY, never with a '$'", () => {
    mount(pos({ symbol: "USDJPY", entryPrice: 150.0, stopLoss: 149.5, lotSize: 0.1 }));
    const text = screen.getByTestId("text-position-risk").textContent ?? "";
    expect(text).not.toContain("$");
    expect(text).toBe("5000.00 JPY");
  });

  it("keeps the standard-lot estimate for a USD-quoted FX pair", () => {
    mount(pos({ symbol: "EURUSD", entryPrice: 1.1, stopLoss: 1.099, lotSize: 1 }));
    expect(screen.getByTestId("text-position-risk").textContent).toBe("$100.00");
  });
});

describe("PositionSideCard status / order type / freshness", () => {
  it("a row the bridge last reported 10 minutes ago is not asserted OPEN and shows its age", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    mount(pos({ symbol: "XAUUSD", lotSize: 0.1, entryPrice: 2400, stopLoss: 2390, observedAt: tenMinAgo, freshness: "STALE" }));
    const status = screen.getByTestId("text-position-status").textContent ?? "";
    expect(status).not.toBe("OPEN");
    expect(status).toMatch(/^Unconfirmed — last reported 10m ago$/);
    expect(screen.getByTestId("text-position-last-reported").textContent).toMatch(/10m ago/);
    // The P/L and price labels say they are the last reported values.
    expect(screen.getByText("Last reported P/L")).toBeTruthy();
    expect(screen.getByText("Last reported price")).toBeTruthy();
    expect(screen.queryByText("Floating P/L")).toBeNull();
  });

  it("a row with no freshness from the server is unconfirmed, never OPEN", () => {
    mount(pos({}));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Unconfirmed — no bridge report time");
  });

  it("never invents an order type from the side", () => {
    mount(pos({ side: "BUY" }));
    const ot = screen.getByTestId("text-position-ordertype").textContent ?? "";
    expect(ot).not.toBe("MARKET_BUY");
    expect(ot).toBe("Not reported");
  });

  it("a freshly reported row reads open and keeps the live labels", () => {
    mount(pos({ observedAt: new Date().toISOString(), freshness: "FRESH" }));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Open — reported by bridge");
    expect(screen.getByText("Floating P/L")).toBeTruthy();
  });
});
