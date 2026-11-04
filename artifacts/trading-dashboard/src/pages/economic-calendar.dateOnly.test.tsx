// Economic Calendar: FRED publishes release DATES only (the provider emits a
// midnight-UTC sentinel and eventTimeLocal=null). A release dated today must
// not be shown as "00:00 UTC · 9h ago", must not drop out of Next Event, and
// Ruby's read must not say it is waiting for calendar data.
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

// Event exactly as the FRED provider + /api/economic-calendar/events emit it.
const FRED_CPI = {
  id: "fred_10_2026-10-28", title: "Consumer Price Index", currency: "USD", impact: "high",
  eventTimeIso: "2026-10-28T00:00:00.000Z", eventTimeUtc: "2026-10-28T00:00:00.000Z", eventTimeLocal: null,
  affectedMarkets: ["EURUSD"], affectedSymbols: ["EURUSD"], country: "United States", source: "FRED",
  forecast: null, previous: null, actual: null, riskNote: "High-impact release",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = String(url).startsWith("/api/economic-calendar/events")
      ? {
          connected: true, provider: "fred", configured: true, eventCount: 1,
          lastFetchAt: NOW.toISOString(), lastErrorAt: null, lastErrorMessage: null,
          freshnessStatus: "fresh", events: [FRED_CPI],
        }
      : { events: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
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

describe("Economic Calendar: date-only (FRED) releases", () => {
  it("the timeline row does not invent a 00:00 UTC release time or say it already happened", async () => {
    renderPage();
    const row = await screen.findByTestId(`event-time-${FRED_CPI.id}`);
    expect(row.textContent).not.toMatch(/00:00/);
    expect(row.textContent).not.toMatch(/ago/);
    expect(row.textContent).toMatch(/time not published/i);
  });

  it("Next Event still lists today's release with an unconfirmed time", async () => {
    renderPage();
    await screen.findByTestId(`event-time-${FRED_CPI.id}`);
    const next = screen.getByTestId("next-event");
    expect(next.textContent).not.toMatch(/No more events/i);
    expect(next.textContent).toContain("Consumer Price Index");
    expect(next.textContent).not.toMatch(/00:00/);
    expect(next.textContent).toMatch(/time not published/i);
  });

  it("Ruby's News Read talks about the pending release, not 'waiting for calendar data'", async () => {
    renderPage();
    await screen.findByTestId(`event-time-${FRED_CPI.id}`);
    expect(screen.queryByText(/is waiting for calendar data/)).toBeNull();
    const read = screen.getByTestId("ruby-news-read");
    expect(read.textContent).toContain("Consumer Price Index");
    expect(read.textContent).not.toMatch(/ago/);
  });
});
