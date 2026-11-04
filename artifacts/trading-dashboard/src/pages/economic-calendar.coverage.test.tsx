// Economic Calendar: when the live provider is not configured, failing, or its
// status cannot be read, the page has not checked the calendar. It must not
// show "Overall Risk: Low", "No major events found for today." or "No
// high-impact events ahead" as if the calendar had been read and was clear.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrainMulti: () => ({ data: undefined }),
  getGetTimingBrainMultiQueryKey: () => ["timing-multi"],
}));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => {}] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: EconomicCalendarPage } = await import("./economic-calendar");

const NOW = new Date("2026-10-28T09:00:00.000Z");
const NOT_CONFIGURED = {
  connected: false, provider: "none", configured: false, eventCount: 0,
  lastFetchAt: null, lastErrorAt: null, lastErrorMessage: null, freshnessStatus: "unavailable", events: [],
};

type Route = { status: number; body: unknown };
let statusRoute: Route;
let dbRoute: Route;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statusRoute = { status: 200, body: NOT_CONFIGURED };
  dbRoute = { status: 200, body: { events: [] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const r = String(url).startsWith("/api/economic-calendar/events") ? statusRoute : dbRoute;
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><EconomicCalendarPage /></QueryClientProvider>);
}

const LOW_DB_EVENT = {
  id: 1, eventName: "Retail sales (minor)", country: "NZ", currency: "NZD", impactLevel: "LOW",
  forecast: null, previous: null, actual: null, eventTime: "2026-10-28T14:00:00.000Z", source: "manual",
  affectedSymbols: null, volatilityFlag: 0,
};

describe("Economic Calendar coverage honesty", () => {
  it("no provider and no stored events: the risk card says the calendar was not read, not 'No major events'", async () => {
    renderPage();
    const card = await screen.findByTestId("market-risk-empty");
    expect(card.textContent).not.toMatch(/No major events found/i);
    expect(card.textContent).toMatch(/no live calendar provider is configured/i);
    expect(card.textContent).toMatch(/not an all-clear/i);
  });

  it("no provider with one minor stored event: Overall Risk is not 'Low'", async () => {
    dbRoute = { status: 200, body: { events: [LOW_DB_EVENT] } };
    renderPage();
    await screen.findAllByText("Retail sales (minor)");
    const overall = screen.getByTestId("overall-risk");
    expect(overall.textContent).not.toBe("Low");
    expect(overall.textContent).toMatch(/unknown/i);
    const upcoming = screen.getByTestId("upcoming-high-impact");
    expect(upcoming.textContent).not.toMatch(/No high-impact events ahead/i);
  });

  it("a failed status request shows a provider-unknown notice", async () => {
    statusRoute = { status: 500, body: { error: "Failed to fetch live calendar events" } };
    dbRoute = { status: 200, body: { events: [LOW_DB_EVENT] } };
    renderPage();
    const notice = await screen.findByTestId("calendar-status-unknown");
    expect(notice.textContent).toMatch(/could not read the calendar provider status/i);
    await screen.findAllByText("Retail sales (minor)");
    expect(screen.getByTestId("overall-risk").textContent).not.toBe("Low");
  });

  it("a connected provider with one low event may say Low", async () => {
    statusRoute = { status: 200, body: {
      connected: true, provider: "trading_economics", configured: true, eventCount: 1,
      lastFetchAt: NOW.toISOString(), lastErrorAt: null, lastErrorMessage: null, freshnessStatus: "fresh",
      events: [{
        id: "te1", title: "Minor", currency: "NZD", impact: "low", eventTimeIso: "2026-10-28T14:00:00.000Z",
        eventTimeUtc: "2026-10-28T14:00:00.000Z", eventTimeLocal: null, affectedMarkets: [], affectedSymbols: [],
        country: "NZ", source: "Trading Economics", forecast: null, previous: null, actual: null, riskNote: null,
      }],
    } };
    renderPage();
    await vi.waitFor(() => expect(screen.getByTestId("overall-risk").textContent).toBe("Low"));
  });
});
