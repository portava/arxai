// /news/calendar returns [] both for "nothing listed" and for "calendar not
// read" (no provider configured / failing fetch). The calendar page and the
// dashboard's Critical Market Events card must not turn the latter into
// "No events in this period." / "No high-impact events in the next 3 days.",
// and an event released hours ago is not "now".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

type Q = { data: unknown; isLoading: boolean; isError: boolean };
const h = vi.hoisted(() => ({
  list: { data: [] as unknown, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  live: { data: undefined as unknown, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetEconomicCalendar: () => h.list,
  useGetLiveCalendarEvents: () => h.live,
}));
vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const { default: CalendarPage } = await import("./calendar");
const { CriticalEventsCard } = await import("@/components/dashboard/cockpit/CockpitCards");

const NOT_CONFIGURED = { connected: false, configured: false, provider: "none", eventCount: 0, events: [] };
const FAILING = { connected: false, configured: true, provider: "trading_economics", eventCount: 0, lastErrorMessage: "HTTP 503", events: [] };
const CONNECTED = { connected: true, configured: true, provider: "trading_economics", eventCount: 0, events: [] };

function set(list: Partial<Q>, live: Partial<Q>) {
  h.list = { data: [], isLoading: false, isError: false, ...list };
  h.live = { data: undefined, isLoading: false, isError: false, ...live };
}

beforeEach(() => set({}, { data: CONNECTED }));
afterEach(cleanup);

describe("calendar page", () => {
  it("no provider configured: says the calendar was not checked, not 'No events in this period.'", () => {
    set({ data: [] }, { data: NOT_CONFIGURED });
    render(<CalendarPage />);
    expect(screen.queryByText("No events in this period.")).toBeNull();
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/No economic calendar provider is configured/);
  });

  it("failing provider: names the failure", () => {
    set({ data: [] }, { data: FAILING });
    render(<CalendarPage />);
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/could not be read \(HTTP 503\)/);
  });

  it("request error: is an error, not an empty period", () => {
    set({ data: undefined, isError: true }, { data: CONNECTED });
    render(<CalendarPage />);
    expect(screen.queryByText("No events in this period.")).toBeNull();
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/Could not load the economic calendar/);
  });

  it("connected and empty: may say no events", () => {
    set({ data: [] }, { data: CONNECTED });
    render(<CalendarPage />);
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/No events in this period/);
  });
});

describe("dashboard Critical Market Events", () => {
  it("no provider configured: not 'No high-impact events in the next 3 days.'", () => {
    set({ data: [] }, { data: NOT_CONFIGURED });
    render(<CriticalEventsCard />);
    expect(screen.queryByText("No high-impact events in the next 3 days.")).toBeNull();
    expect(screen.getByTestId("critical-events-empty").textContent).toMatch(/not checked/);
  });

  it("an event released 3h ago does not read 'now'", () => {
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    set({ data: [{ id: "e1", title: "CPI", country: "US", currency: "USD", impact: "high", eventTime: past, affectedMarkets: [], source: "Trading Economics", actual: null, forecast: null, previous: null }] }, { data: CONNECTED });
    render(<CriticalEventsCard />);
    const row = screen.getByTestId("event-e1");
    expect(row.textContent).not.toMatch(/\bnow\b/);
    expect(row.textContent).toMatch(/3h ago/);
  });

  it("a FRED date-only release dated today shows no invented time", () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    set({ data: [{ id: "f1", title: "Consumer Price Index", country: "United States", currency: "USD", impact: "high", eventTime: `${ymd}T00:00:00.000Z`, affectedMarkets: [], source: "FRED", actual: null, forecast: null, previous: null }] }, { data: { ...CONNECTED, provider: "fred" } });
    render(<CriticalEventsCard />);
    const row = screen.getByTestId("event-f1");
    expect(row.textContent).not.toMatch(/\bnow\b|ago/);
    expect(row.textContent).toMatch(/time not published/);
  });
});
