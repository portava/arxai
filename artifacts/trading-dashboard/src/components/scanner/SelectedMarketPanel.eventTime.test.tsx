// FRED publishes only a release DATE; its rows carry a midnight-UTC date marker
// as eventTime. The Selected Market panel counted down to that marker ("in
// 437m", ticking every second) while the Calendar page and Cockpit card say
// "tomorrow" / "today · time not published" for the same event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setChartSymbol } from "@/lib/use-chart-symbol";
import { calendarEventWhen } from "@/lib/calendarCoverage";

vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["5m", vi.fn()] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
vi.mock("@/components/scanner/SymbolExplorer", () => ({ SymbolExplorer: () => null }));
import { SelectedMarketPanel } from "./SelectedMarketPanel";

const DAY = 86_400_000;
const utcMidnight = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

function snapshot(events: unknown[]) {
  return { ok: true, symbol: "EURUSD", symbolRaw: "EURUSD", timeframe: "M5",
    highlights: { bias: "WAIT", confidenceLabel: "Low", confidenceScore: 20, volatilityLabel: "Calm", trendState: "neutral", entryZone: null, suggestedStop: null, suggestedTakeProfit: null, riskRewardRatio: 0, riskWarnings: [] },
    explanation: { hedge: "Awaiting a verified setup.", why: "No confirmed setup.", whyItMatters: "Wait.", risk: "Unknown.", invalidation: "Unknown.", cautions: [], disclaimer: "Decision support only." },
    upcomingEvents: events,
    newsRisk: { riskLevel: "low", blockTrading: false, summary: "", calendarChecked: true, calendarNote: null },
    dataSource: "LIVE_FEED", dataState: "UNAVAILABLE", dataAsOf: "2026-10-26T12:00:00.000Z", generatedAt: "2026-10-26T12:00:01.000Z", levelsWithheld: true, cacheHit: false,
  };
}

let body: unknown;
let client: QueryClient;
beforeEach(() => {
  localStorage.clear(); setChartSymbol("EURUSD");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).includes("/deriv/status")) return Promise.resolve(new Response(JSON.stringify({ configured: false })));
    return Promise.resolve(new Response(JSON.stringify(body)));
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

const mount = () => render(<QueryClientProvider client={client}><SelectedMarketPanel /></QueryClientProvider>);

describe("Selected Market — date-only calendar events", () => {
  it("a FRED release dated tomorrow says when, the way the calendar page does — never a minute countdown", async () => {
    const now = Date.now();
    const marker = new Date(utcMidnight(now) + DAY).toISOString();
    const event = { externalId: "fred-cpi", title: "CPI", currency: "USD", impactLevel: "HIGH", eventTime: marker, minutesUntil: 437, source: "FRED", timePublished: false };
    body = snapshot([event]);
    mount();
    const cell = await screen.findByTestId("text-selected-event-countdown");
    expect(cell.textContent).not.toMatch(/^in \d+m$/);
    expect(cell.textContent).toBe(calendarEventWhen(event, Date.now()).label);
  });

  it("a FRED release dated today reads 'time not published'", async () => {
    const now = Date.now();
    const marker = new Date(utcMidnight(now)).toISOString();
    const event = { externalId: "fred-gdp", title: "GDP", currency: "USD", impactLevel: "HIGH", eventTime: marker, minutesUntil: -600, source: "FRED", timePublished: false };
    body = snapshot([event]);
    mount();
    const cell = await screen.findByTestId("text-selected-event-countdown");
    expect(cell.textContent).not.toMatch(/\d+m ago/);
    expect(cell.textContent).toBe(calendarEventWhen(event, Date.now()).label);
  });

  it("a timed event keeps its live countdown", async () => {
    const at = new Date(Date.now() + 90 * 60_000).toISOString();
    body = snapshot([{ externalId: "te-nfp", title: "NFP", currency: "USD", impactLevel: "HIGH", eventTime: at, minutesUntil: 90, source: "trading_economics", timePublished: true }]);
    mount();
    expect((await screen.findByTestId("text-selected-event-countdown")).textContent).toMatch(/^in (89|90)m$/);
  });
});
