// Truth: My Open Trades printed (unrealizedPnl ?? 0) — a P/L the server did
// not report rendered as "+0.00", a flat position that was never observed.
// An unreported P/L is now "—"; a reported 0 reads "0.00" without a sign.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MyOpenTradesPanel, type OpenCard } from "./MyOpenTradesPanel";

const card = (over: Partial<OpenCard>): OpenCard => ({
  id: "lp_1", source: "user_owned_mt5", routingMode: "USER_OWNED_MT5", accountType: "demo",
  symbol: "EURUSD", side: "BUY", lotSize: 1, entryPrice: 1.085, currentPrice: null,
  stopLoss: null, takeProfit: null, unrealizedPnl: null, pnlIsEstimate: false, pnlPercent: null,
  status: "OPEN", openedAt: "2026-10-28T08:00:00Z", brokerLabelMasked: null, waitingForSync: false,
  ...over,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stub(cards: OpenCard[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url).endsWith("/api/me/trades/open")
      ? new Response(JSON.stringify({ ok: true, routingMode: "USER_OWNED_MT5", accountType: "demo", tradingMode: "DEMO", bannerLabel: "DEMO", cards }), { status: 200 })
      : new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
}

describe("My Open Trades P/L", () => {
  it("an unreported P/L reads —, never +0.00", async () => {
    stub([card({}), card({ id: "lp_2", symbol: "GBPUSD", unrealizedPnl: 0 }), card({ id: "lp_3", symbol: "USDJPY", unrealizedPnl: -12.5 })]);
    render(<MyOpenTradesPanel />);
    await waitFor(() => expect(screen.getByTestId("pnl-lp_1")).toBeTruthy());
    expect(screen.getByTestId("pnl-lp_1").textContent).toBe("—");
    expect(screen.getByTestId("pnl-lp_1").getAttribute("title")).toMatch(/not reported/);
    expect(screen.getByTestId("pnl-lp_2").textContent).toBe("0.00");
    expect(screen.getByTestId("pnl-lp_3").textContent).toBe("-12.50");
    expect(document.body.textContent).not.toContain("+0.00");
  });
});
