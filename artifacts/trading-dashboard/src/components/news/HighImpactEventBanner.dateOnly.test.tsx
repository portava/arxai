// High-impact banner — FRED publishes release DATES only; synced rows carry
// source "fred" and a midnight-UTC sentinel time. Between 23:00 and 00:30 UTC
// the banner's window query returns such a row. Its release time is unknown, so
// the banner must not give it a countdown, a "released Xm ago" age, a
// "within 1 hour" / "post-release volatility window" heading or a pulse.
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

  it("before the midnight sentinel: no 'in 45m' countdown", async () => {
    vi.setSystemTime(new Date("2026-10-27T23:15:00.000Z"));
    mount([FOMC]);
    const row = await screen.findByTestId("high-impact-event-1");
    expect(row.textContent).not.toMatch(/in \d+m/);
    expect(row.textContent).toMatch(/release time not published/);
    expect(screen.getByTestId("high-impact-banner").textContent).not.toMatch(/within 1 hour/);
  });

  it("a timed event next to a date-only one keeps its countdown", async () => {
    vi.setSystemTime(new Date("2026-10-27T23:40:00.000Z"));
    mount([FOMC, { id: 2, eventName: "CPI y/y", currency: "USD", impactLevel: "HIGH", eventTime: "2026-10-28T00:00:00.000Z", source: "tradingeconomics" }]);
    const timed = await screen.findByTestId("high-impact-event-2");
    expect(timed.textContent).toMatch(/^in 20m · HIGH/);
    expect(screen.getByTestId("high-impact-event-1").textContent).toMatch(/release time not published/);
    expect(screen.getByTestId("high-impact-banner").textContent).toMatch(/within 1 hour/);
  });
});
