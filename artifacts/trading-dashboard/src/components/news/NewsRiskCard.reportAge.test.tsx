// NewsRiskCard report-age truth.
//
// /api/news-risk/latest returns the newest persisted report with no age
// filter, and its riskLevel / timeUntilEventMinutes were computed when the
// scan ran. A 40-minute-old "NO TRADE WINDOW · Event in 12m" report must not
// render as the current risk: the countdown is recomputed from createdAt and
// the report is labelled as an outdated scan.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewsRiskCard } from "./NewsRiskCard";

const PROVIDERS = [
  { kind: "news", connected: true, name: "finnhub" },
  { kind: "calendar", connected: true, name: "tradingeconomics" },
];

function report(ageMin: number, timeUntilEventMinutes: number) {
  return {
    id: 1,
    symbol: "EURUSD",
    relatedCurrency: "USD",
    eventId: 9,
    riskLevel: "NO_TRADE_WINDOW",
    timeUntilEventMinutes,
    tradeWarning:
      "NO TRADE WINDOW: HIGH impact Non-Farm Payrolls (USD) in 12m. Trading blocked for this symbol while the no-trade window is active.",
    aiSummary: 'EURUSD: HIGH impact "Non-Farm Payrolls" (USD) in 12m. Risk: NO TRADE WINDOW.',
    createdAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
    news: null,
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

describe("NewsRiskCard report age", () => {
  it("a 40-minute-old 'event in 12m' report is labelled outdated and the countdown is recomputed", async () => {
    mount(report(40, 12));
    const level = await screen.findByTestId("news-risk-level");
    expect(screen.getByTestId("news-risk-outdated").textContent).toMatch(/Outdated scan/);
    expect(screen.getByTestId("news-risk-outdated").textContent).toMatch(/40m ago/);
    expect(screen.getByTestId("news-risk-event-time").textContent).toBe("Event 28m ago");
    expect(document.body.textContent).not.toContain("Event in 12m");
    // The risk badge is the scan-time label, not a live red NO TRADE WINDOW.
    expect(level.textContent).toMatch(/^At .*: NO TRADE WINDOW$/);
    expect(level.className).not.toContain("animate-pulse");
    expect(screen.getByTestId("news-risk-warning").textContent).not.toContain("⚠ Do not trade");
    expect(screen.getByTestId("news-risk-warning").textContent).toMatch(/At scan time/);
    expect(screen.getByTestId("news-risk-summary").textContent).toMatch(/^At scan time/);
  });

  it("a just-generated report is shown as current", async () => {
    mount(report(0, 12));
    const level = await screen.findByTestId("news-risk-level");
    expect(screen.queryByTestId("news-risk-outdated")).toBeNull();
    expect(level.textContent).toBe("NO TRADE WINDOW");
    expect(level.className).toContain("animate-pulse");
    expect(screen.getByTestId("news-risk-event-time").textContent).toBe("Event in 12m");
    expect(screen.getByTestId("news-risk-warning").textContent).toContain("⚠ Do not trade");
  });
});
