// High-impact banner — FRED publishes release DATES only; synced rows carry
// source "fred" and a midnight-UTC sentinel time. Its release time is unknown,
// so the banner must not give it a countdown, a "released Xm ago" age, a
// "within 1 hour" / "post-release volatility window" heading or a pulse — and
// WHEN it is shown must not come from that sentinel either: it is shown for
// the whole UTC date it carries (read with a day-wide query), never only
// between 23:00 and 00:30 UTC because the 1-hour window query caught the
// sentinel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HighImpactEventBanner } from "./HighImpactEventBanner";

const FOMC = { id: 1, eventName: "FOMC", currency: "USD", impactLevel: "CRITICAL", eventTime: "2026-10-28T00:00:00.000Z", source: "fred" };

function mount(events: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events }), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><HighImpactEventBanner /></QueryClientProvider>);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("HighImpactEventBanner date-only events", () => {
  it("after the midnight sentinel: no 'released 12m ago' and no post-release window", async () => {
    vi.setSystemTime(new Date("2026-10-28T00:12:00.000Z"));
    mount([FOMC]);
    const row = await screen.findByTestId("high-impact-event-1");
    expect(row.textContent).not.toMatch(/released \d+m ago/);
    expect(row.textContent).toMatch(/release time not published/);
    const banner = screen.getByTestId("high-impact-banner");
    expect(banner.textContent).not.toMatch(/post-release volatility window/);
    expect(banner.textContent).not.toMatch(/within 1 hour/);
    expect(banner.className).not.toContain("animate-pulse");
  });

  it("a timed event next to a date-only one keeps its countdown", async () => {
    vi.setSystemTime(new Date("2026-10-28T17:40:00.000Z"));
    mount([FOMC, { id: 2, eventName: "CPI y/y", currency: "USD", impactLevel: "HIGH", eventTime: "2026-10-28T18:00:00.000Z", source: "tradingeconomics" }]);
    const timed = await screen.findByTestId("high-impact-event-2");
    expect(timed.textContent).toMatch(/^in 20m · HIGH/);
    expect(screen.getByTestId("high-impact-event-1").textContent).toMatch(/release time not published/);
    expect(screen.getByTestId("high-impact-banner").textContent).toMatch(/within 1 hour/);
  });

  // Review finding: the heading's severity, count and colour came from every
  // row, so a HIGH timed CPI next to an untimed CRITICAL FOMC read "Critical
  // economic events within 1 hour" in red. Nothing critical is known to be
  // within the hour; the untimed row is named on its own, by date.
  it("an untimed critical row does not make the 'within 1 hour' heading critical", async () => {
    vi.setSystemTime(new Date("2026-10-28T17:40:00.000Z"));
    mount([FOMC, { id: 2, eventName: "CPI y/y", currency: "USD", impactLevel: "HIGH", eventTime: "2026-10-28T18:00:00.000Z", source: "tradingeconomics" }]);
    await screen.findByTestId("high-impact-event-2");
    const banner = screen.getByTestId("high-impact-banner");
    const heading = banner.firstElementChild?.textContent ?? "";
    expect(heading).toMatch(/^⚠ High-impact economic event within 1 hour/);
    expect(heading).not.toMatch(/Critical economic/);
    expect(heading).not.toMatch(/events within 1 hour/);
    expect(heading).toMatch(/also dated 2026-10-28, release time not published: FOMC \(critical\)/);
    expect(banner.className).not.toContain("border-red-700");
    expect(banner.className).not.toContain("animate-pulse");
    expect(screen.getByTestId("high-impact-event-1").textContent).toMatch(/2026-10-28 \(release time not published\) · CRITICAL/);
  });
});

// Review finding: the 1-hour window query and filter selected FRED rows by
// their midnight sentinel, so a CRITICAL FOMC dated 2026-10-28 was bannered
// only from 23:00 to 00:30 UTC (the previous evening in New York) and showed
// nothing on its actual release day — while no banner reads as "nothing in
// the next hour".
describe("HighImpactEventBanner date-only events follow their date, not the sentinel", () => {
  function routed(byUrl: { upcoming: unknown[] | number; day: unknown[] | number }) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const pick = url.includes("/api/economic-events/upcoming") ? byUrl.upcoming : byUrl.day;
      return typeof pick === "number"
        ? new Response(JSON.stringify({ error: "boom" }), { status: pick })
        : new Response(JSON.stringify({ events: pick }), { status: 200 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={qc}><HighImpactEventBanner /></QueryClientProvider>);
    return { calls, view };
  }

  it("on its release day, hours after the sentinel, a release dated today is still bannered by date", async () => {
    vi.setSystemTime(new Date("2026-10-28T17:45:00.000Z"));
    const { calls } = routed({ upcoming: [], day: [FOMC] });
    const row = await screen.findByTestId("high-impact-event-1");
    expect(row.textContent).toMatch(/^2026-10-28 \(release time not published\) · CRITICAL/);
    const heading = screen.getByTestId("high-impact-banner").firstElementChild?.textContent ?? "";
    expect(heading).toBe("⚠ Critical economic event dated 2026-10-28 — release time not published");
    expect(screen.getByTestId("high-impact-banner").className).not.toContain("animate-pulse");
    // The day read reaches back past today's UTC midnight (17h45m ago).
    const dayUrl = calls.find((u) => !u.includes("/upcoming")) ?? "";
    expect(dayUrl).toMatch(/^\/api\/economic-events\?/);
    const pastHours = Number(new URL(dayUrl, "http://x").searchParams.get("pastHours"));
    expect(pastHours).toBeGreaterThanOrEqual(18);
  });

  it("the window query's sentinel never banners a release dated tomorrow", async () => {
    vi.setSystemTime(new Date("2026-10-27T23:15:00.000Z"));
    const { calls, view } = routed({ upcoming: [FOMC], day: [] });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("high-impact-banner")).toBeNull();
    expect(view.container.textContent ?? "").not.toMatch(/in \d+m/);
  });

  it("the same release stays bannered all of its date, before and after the sentinel window", async () => {
    for (const at of ["2026-10-28T00:10:00.000Z", "2026-10-28T09:00:00.000Z", "2026-10-28T23:50:00.000Z"]) {
      vi.setSystemTime(new Date(at));
      routed({ upcoming: [], day: [FOMC] });
      expect((await screen.findByTestId("high-impact-event-1")).textContent).toMatch(/2026-10-28 \(release time not published\)/);
      cleanup();
    }
  });

  it("a failed day read is said, never rendered as a quiet calendar", async () => {
    vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
    routed({ upcoming: [], day: 500 });
    const note = await screen.findByTestId("high-impact-banner-date-only-unavailable");
    expect(note.textContent).toMatch(/could not be loaded/);
    expect(note.textContent).toMatch(/not an all-clear/);
  });
});
