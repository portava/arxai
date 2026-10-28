import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Economic Calendar page — every tile and label must say what the calendar
// source actually reported. These tests drive the real page with a stubbed
// fetch that mirrors the two server routes it reads:
//   live path: GET /api/economic-calendar/events  (economicCalendarProvider)
//   DB path:   GET /api/economic-events           (newsCalendar.ts, window
//              eventTime between now and now + days*24h)

const timing = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetTimingBrainMulti: () => ({ data: timing.data }),
  getGetTimingBrainMultiQueryKey: (p: unknown) => ["timing-brain-multi", p],
}));

const { default: EconomicCalendarPage } = await import("./economic-calendar");

// Local-time anchors so "today"/"tomorrow" are independent of the runner's TZ.
const NOW = new Date(2026, 9, 28, 9, 0, 0);
const at = (dayOffset: number, h: number, m = 0) =>
  new Date(2026, 9, 28 + dayOffset, h, m, 0).toISOString();

interface LiveEvt {
  id: string; title: string; currency: string; impact: string; impactTier?: string;
  eventTimeIso: string; eventTimeUtc: string; affectedMarkets: string[]; affectedSymbols: string[];
  country: string; source: string; forecast: string | null; previous: string | null;
  actual: string | null; riskNote: string | null;
}
function liveEvt(over: Partial<LiveEvt> & { id: string; title: string; when: string }): LiveEvt {
  const { when, ...rest } = over;
  return {
    currency: "USD", impact: "high", eventTimeIso: when, eventTimeUtc: when,
    affectedMarkets: [], affectedSymbols: [], country: "United States", source: "TE",
    forecast: null, previous: null, actual: null, riskNote: null,
    ...rest,
  };
}

interface DbEvt {
  id: number; eventName: string; country: string; currency: string;
  impactLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  forecast: string | null; previous: string | null; actual: string | null;
  eventTime: string; source: string; affectedSymbols: string[] | null; volatilityFlag: number;
}
function dbEvt(over: Partial<DbEvt> & { id: number; eventName: string; eventTime: string }): DbEvt {
  return {
    country: "United States", currency: "USD", impactLevel: "HIGH",
    forecast: null, previous: null, actual: null, source: "manual",
    affectedSymbols: null, volatilityFlag: 0,
    ...over,
  };
}

type Calls = string[];
function stubServer(opts: { live?: LiveEvt[]; db?: DbEvt[] }): Calls {
  const calls: Calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/economic-calendar/events") {
      if (!opts.live) {
        return { ok: true, status: 200, json: async () => ({
          connected: false, provider: "none", configured: false, eventCount: 0,
          lastFetchAt: null, lastErrorAt: null, lastErrorMessage: null,
          freshnessStatus: "unavailable", events: [],
        }) };
      }
      // Mirror getEnrichedCalendarEvents: currency + minimum-impact filters.
      const rank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 3 };
      const cur = u.searchParams.get("currencies");
      const imp = u.searchParams.get("impact");
      const events = opts.live.filter((e) =>
        (!cur || cur.split(",").includes(e.currency))
        && (!imp || (rank[e.impactTier ?? e.impact] ?? 0) >= (rank[imp] ?? 0)));
      return { ok: true, status: 200, json: async () => ({
        connected: true, provider: "trading_economics", configured: true,
        eventCount: events.length, lastFetchAt: NOW.toISOString(), lastErrorAt: null,
        lastErrorMessage: null, freshnessStatus: "fresh", events,
      }) };
    }
    if (u.pathname === "/api/economic-events") {
      // Mirror newsCalendar.ts: eventTime in [now - pastHours, now + days*24h].
      const days = Number(u.searchParams.get("days") ?? 7);
      const pastHours = Number(u.searchParams.get("pastHours") ?? 0);
      const since = Date.now() - pastHours * 3600_000;
      const until = Date.now() + days * 86_400_000;
      const cur = u.searchParams.get("currency");
      const imp = u.searchParams.get("impact");
      const events = (opts.db ?? []).filter((e) => {
        const t = new Date(e.eventTime).getTime();
        return t >= since && t <= until && (!cur || e.currency === cur) && (!imp || e.impactLevel === imp);
      });
      return { ok: true, status: 200, json: async () => ({ events }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  return calls;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<EconomicCalendarPage />, { wrapper: wrap });
}

function row(name: string): HTMLElement {
  const rows = screen.getAllByTestId("eco-event-row");
  const hit = rows.find((r) => r.textContent?.includes(name));
  if (!hit) throw new Error(`no row for ${name}`);
  return hit;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  timing.data = undefined;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("impact tiers agree across sources", () => {
  it("a provider-critical event (FOMC) is Critical on the live path, and an unmapped impact is not 'Low'", async () => {
    stubServer({ live: [
      liveEvt({ id: "fomc", title: "Fed Interest Rate Decision", when: at(0, 18), impact: "high", impactTier: "critical" }),
      liveEvt({ id: "odd", title: "Odd Survey", when: at(0, 15), impact: "weird" }),
    ] });
    renderPage();
    await screen.findAllByTestId("eco-event-row");
    expect(screen.getByTestId("eco-critical-count").textContent).toBe("1");
    expect(within(row("Fed Interest Rate Decision")).getByText("Critical")).toBeTruthy();
    const odd = row("Odd Survey");
    expect(within(odd).queryByText("Low")).toBeNull();
    expect(within(odd).getByText(/Impact not reported/)).toBeTruthy();
  });

  it("the 'Critical' filter on the live path lists only critical events, not every high one", async () => {
    stubServer({ live: [
      liveEvt({ id: "fomc", title: "Fed Interest Rate Decision", when: at(0, 18), impact: "high", impactTier: "critical" }),
      liveEvt({ id: "nfp", title: "Non Farm Payrolls", when: at(0, 13, 30), impact: "high", impactTier: "high" }),
    ] });
    renderPage();
    await screen.findAllByTestId("eco-event-row");
    fireEvent.click(screen.getByRole("button", { name: "Critical" }));
    await waitFor(() => expect(screen.getAllByTestId("eco-event-row")).toHaveLength(1));
    expect(row("Fed Interest Rate Decision")).toBeTruthy();
    expect(screen.queryByText("Non Farm Payrolls", { selector: "[data-testid=eco-event-row] *" })).toBeNull();
  });
});
