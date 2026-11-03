// NewsRiskCard: ARX's 24h critical-event trade-plan hold is not a live
// no-trade window.
//
// A CRITICAL USD event 20 hours away is stored as riskLevel NO_TRADE_WINDOW
// (blockTrading true — the trade-plan validation hold, kept as it is). The
// report's own warning says "TRADE PLAN HOLD: ... orders placed outside a trade
// plan are not held by this check", yet the card put a pulsing red
// "NO TRADE WINDOW" badge and a "⚠ Do not trade" header above that sentence.
// A HIGH no-trade window, and a CRITICAL release window, only exist within
// ±15 minutes of the release; past that the block is the trade-plan hold. The
// card reads that from the stored row (no schema change).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewsRiskCard } from "./NewsRiskCard";

const PROVIDERS = [
  { kind: "news", connected: true, name: "finnhub" },
  { kind: "calendar", connected: true, name: "tradingeconomics" },
];

function report(over: Record<string, unknown>) {
  return {
    id: 1,
    symbol: "EURUSD",
    relatedCurrency: "USD",
    eventId: 7,
    riskLevel: "NO_TRADE_WINDOW",
    timeUntilEventMinutes: 1200,
    tradeWarning:
      "TRADE PLAN HOLD: CRITICAL impact FOMC Rate Decision (USD) in 20h 0m. ARX does not validate trade plans on EURUSD from 24 hours before a critical event until 2 hours after it; orders placed outside a trade plan are not held by this check. The release itself is not due for 20h 0m.",
    aiSummary: 'EURUSD: CRITICAL impact "FOMC Rate Decision" (USD) in 20h 0m. Risk: TRADE PLAN HOLD.',
    createdAt: new Date().toISOString(),
    news: null,
    ...over,
  };
}

function mount(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/market-heat/diagnostics")) {
        return new Response(JSON.stringify({ providers: PROVIDERS }), { status: 200 });
      }
      if (url.includes("/api/news-risk/latest")) return new Response(JSON.stringify(body), { status: 200 });
      return new Response("not found", { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewsRiskCard symbol="EURUSD" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NewsRiskCard critical-event trade-plan hold", () => {
  it("a CRITICAL event 20h away shows TRADE PLAN HOLD, not a pulsing NO TRADE WINDOW / Do not trade", async () => {
    mount(report({}));
    const level = await screen.findByTestId("news-risk-level");
    expect(level.textContent).toBe("TRADE PLAN HOLD");
    expect(level.className).not.toContain("animate-pulse");
    const warning = screen.getByTestId("news-risk-warning").textContent ?? "";
    expect(warning).toContain("Trade plans held");
    expect(warning).not.toMatch(/Do not trade/i);
    expect(document.body.textContent).not.toContain("NO TRADE WINDOW");
    expect(screen.getByTestId("text-news-risk-event-countdown").textContent).toMatch(/^Event in /);
  });

  it("an older stored hold row (old 'NO TRADE WINDOW:' wording) is still labelled by its distance from the release", async () => {
    mount(report({
      timeUntilEventMinutes: -45,
      tradeWarning: "NO TRADE WINDOW: CRITICAL impact FOMC Rate Decision (USD) 45m ago. ARX holds new trades on EURUSD from 24 hours before a critical event until 2 hours after it.",
      aiSummary: 'EURUSD: CRITICAL impact "FOMC Rate Decision" (USD) 45m ago. Risk: NO TRADE WINDOW.',
    }));
    const level = await screen.findByTestId("news-risk-level");
    expect(level.textContent).toBe("TRADE PLAN HOLD");
    expect(screen.getByTestId("news-risk-warning").textContent).not.toMatch(/Do not trade/i);
  });

  it("an outdated hold report says trade plans were held at scan time", async () => {
    mount(report({ createdAt: new Date(Date.now() - 40 * 60_000).toISOString() }));
    const level = await screen.findByTestId("news-risk-level");
    expect(level.textContent).toMatch(/^At .*: TRADE PLAN HOLD$/);
    const warning = screen.getByTestId("news-risk-warning").textContent ?? "";
    expect(warning).toMatch(/At scan time .*: trade plans held/);
    expect(warning).not.toMatch(/do not trade/i);
  });

  it("a release inside its 15-minute window keeps the live NO TRADE WINDOW badge", async () => {
    mount(report({
      timeUntilEventMinutes: 5,
      tradeWarning: "NO TRADE WINDOW: CRITICAL impact FOMC Rate Decision (USD) in 5m. Trading blocked for this symbol while the no-trade window is active.",
    }));
    const level = await screen.findByTestId("news-risk-level");
    expect(level.textContent).toBe("NO TRADE WINDOW");
    expect(level.className).toContain("animate-pulse");
    expect(screen.getByTestId("news-risk-warning").textContent).toContain("⚠ Do not trade");
  });
});
