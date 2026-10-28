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
