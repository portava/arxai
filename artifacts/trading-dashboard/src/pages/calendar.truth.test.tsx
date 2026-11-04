// /news/calendar returns [] both for "nothing listed" and for "calendar not
// read" (no provider configured / failing fetch). The calendar page and the
// dashboard's Critical Market Events card must not turn the latter into
// "No events in this period." / "No high-impact events in the next 3 days.",
// and an event released hours ago is not "now".
//
// Both surfaces read the events AND whether the calendar was read from ONE
// response (GET /news/calendar/envelope). They used to pair the /news/calendar
// list with the provider status from a second endpoint, read at a different
// moment by a different request — so a failed list read next to a connected
// status said "No events". The legacy hooks below always report that
// misleading pair (empty list + connected provider): a surface that still
// consults them prints the all-clear and fails these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

type Q = { data: unknown; isLoading: boolean; isError: boolean };
const CONNECTED = { connected: true, configured: true, provider: "trading_economics", eventCount: 0, events: [] };
const h = vi.hoisted(() => ({
  env: { data: undefined as unknown, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  list: { data: [] as unknown, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  live: { data: undefined as unknown, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetEconomicCalendarEnvelope: () => h.env,
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

const NOT_ALL_CLEAR = "This is not an all-clear.";
function envelope(over: Record<string, unknown>) {
  return { read: true, status: "ok", provider: "trading_economics", configured: true, eventsAsOf: null, checkedAt: new Date().toISOString(), note: null, windowDays: 3, events: [], ...over };
}
const NOT_CONFIGURED = envelope({ read: false, status: "missing", provider: "none", configured: false,
  note: `No economic calendar provider is configured, so scheduled events were not checked. ${NOT_ALL_CLEAR}` });
const FAILING = envelope({ read: false, status: "error",
  note: `Trading Economics could not be read (HTTP 503), so scheduled events were not checked. ${NOT_ALL_CLEAR}` });
const READ_EMPTY = envelope({ status: "empty" });

/** The envelope drives the surface; the legacy pair always claims "connected, nothing listed". */
function set(env: Partial<Q>) {
  h.env = { data: undefined, isLoading: false, isError: false, ...env };
  const events = (h.env.data as { events?: unknown[] } | undefined)?.events ?? [];
  h.list = { data: events, isLoading: false, isError: false };
  h.live = { data: CONNECTED, isLoading: false, isError: false };
}

beforeEach(() => set({ data: READ_EMPTY }));
afterEach(cleanup);

describe("calendar page", () => {
  it("no provider configured: says the calendar was not checked, not 'No events in this period.'", () => {
    set({ data: NOT_CONFIGURED });
    render(<CalendarPage />);
    expect(screen.queryByText("No events in this period.")).toBeNull();
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/No economic calendar provider is configured/);
  });

  it("failing provider: names the failure", () => {
    set({ data: FAILING });
    render(<CalendarPage />);
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/could not be read \(HTTP 503\)/);
  });

  it("request error: is an error, not an empty period", () => {
    set({ data: undefined, isError: true });
    render(<CalendarPage />);
    expect(screen.queryByText("No events in this period.")).toBeNull();
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/Could not load the economic calendar/);
  });

  it("connected and empty: may say no events", () => {
    set({ data: READ_EMPTY });
    render(<CalendarPage />);
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/No events in this period/);
  });
});

describe("calendar page — one read", () => {
  it("a failed refresh does not keep showing the last list as current", () => {
    set({ data: envelope({ events: [{ id: "e9", title: "NFP", country: "US", currency: "USD", impact: "high", eventTime: new Date(Date.now() + 3600_000).toISOString(), affectedMarkets: [], source: "Trading Economics", actual: null, forecast: null, previous: null }] }), isError: true });
    render(<CalendarPage />);
    expect(screen.queryByText("NFP")).toBeNull();
    expect(screen.getByTestId("calendar-empty").textContent).toMatch(/Could not load the economic calendar/);
  });

  it("says which provider was read and when its events were fetched", () => {
    set({ data: envelope({ eventsAsOf: "2026-10-28T09:15:00.000Z" }) });
    render(<CalendarPage />);
    expect(screen.getByTestId("calendar-events-as-of").textContent).toBe("Trading Economics · events fetched 09:15 UTC");
  });

  it("a read with no fetch time does not invent one", () => {
    set({ data: envelope({ eventsAsOf: null }) });
    render(<CalendarPage />);
    expect(screen.queryByTestId("calendar-events-as-of")).toBeNull();
  });
});

describe("dashboard Critical Market Events", () => {
  it("failing provider: not an all-clear", () => {
    set({ data: FAILING });
    render(<CriticalEventsCard />);
    expect(screen.queryByText("No high-impact events in the next 3 days.")).toBeNull();
    expect(screen.getByTestId("critical-events-empty").textContent).toMatch(/could not be read \(HTTP 503\)/);
  });

  it("request error: could not be loaded, not an all-clear", () => {
    set({ data: undefined, isError: true });
    render(<CriticalEventsCard />);
    expect(screen.getByTestId("critical-events-empty").textContent).toMatch(/Could not load the economic calendar/);
  });

  it("connected and empty: may say no high-impact events", () => {
    set({ data: READ_EMPTY });
    render(<CriticalEventsCard />);
    expect(screen.getByTestId("critical-events-empty").textContent).toBe("No high-impact events in the next 3 days.");
  });

  it("no provider configured: not 'No high-impact events in the next 3 days.'", () => {
    set({ data: NOT_CONFIGURED });
    render(<CriticalEventsCard />);
    expect(screen.queryByText("No high-impact events in the next 3 days.")).toBeNull();
    expect(screen.getByTestId("critical-events-empty").textContent).toMatch(/not checked/);
  });

  it("an event released 3h ago does not read 'now'", () => {
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    set({ data: envelope({ events: [{ id: "e1", title: "CPI", country: "US", currency: "USD", impact: "high", eventTime: past, affectedMarkets: [], source: "Trading Economics", actual: null, forecast: null, previous: null }] }) });
    render(<CriticalEventsCard />);
    const row = screen.getByTestId("event-e1");
    expect(row.textContent).not.toMatch(/\bnow\b/);
    expect(row.textContent).toMatch(/3h ago/);
  });

  it("a FRED date-only release dated today shows no invented time", () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    set({ data: envelope({ provider: "fred", events: [{ id: "f1", title: "Consumer Price Index", country: "United States", currency: "USD", impact: "high", eventTime: `${ymd}T00:00:00.000Z`, affectedMarkets: [], source: "FRED", actual: null, forecast: null, previous: null }] }) });
    render(<CriticalEventsCard />);
    const row = screen.getByTestId("event-f1");
    expect(row.textContent).not.toMatch(/\bnow\b|ago/);
    expect(row.textContent).toMatch(/time not published/);
  });
});
