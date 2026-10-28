// News Risk page — an empty event list from a stored calendar that does not
// reach the end of the window is not "no upcoming events".
//
// /api/economic-events/upcoming and /api/news-risk/latest read the
// economic_events table, which only a manual "Sync events" fills. With a
// connected provider and a never-synced table, the list said "No upcoming
// events in the next 24h", no banner showed, and the card read CLEAR while the
// Economic Calendar page showed NFP in 30 minutes. The server now reports
// calendarCoverage; these components must say "not checked" when
// windowCovered is false, and keep their plain empty state only when it is true.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpcomingEventsList } from "./UpcomingEventsList";
import { HighImpactEventBanner } from "./HighImpactEventBanner";
import { NewsRiskCard } from "./NewsRiskCard";

const NEVER_SYNCED = {
  windowCovered: false, coveredThrough: null, storedEventCount: 0, providerConfigured: true,
  note: "The stored economic calendar is empty (events have never been synced), so upcoming events cannot be ruled out.",
};
const COVERED = { windowCovered: true, coveredThrough: "2099-01-01T00:00:00.000Z", storedEventCount: 40, providerConfigured: true, note: null };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function stubFetch(coverage: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/economic-events/upcoming")) return json({ events: [], windowHours: 24, minImpact: "MEDIUM", calendarCoverage: coverage });
    if (url.includes("/api/market-heat/diagnostics")) {
      return json({ providers: [{ kind: "news", connected: true, name: "finnhub" }, { kind: "calendar", connected: true, name: "te" }] });
    }
    if (url.includes("/api/news-risk/latest")) {
      return json({
        id: 1, symbol: "EURUSD", relatedCurrency: null, eventId: null, riskLevel: "CLEAR", timeUntilEventMinutes: null,
        tradeWarning: null, aiSummary: "No scheduled event in window.", createdAt: new Date().toISOString(),
        news: null, calendarCoverage: coverage,
      });
    }
    return new Response("not found", { status: 404 });
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("stored calendar not covering the window", () => {
  it("UpcomingEventsList says events cannot be ruled out instead of 'No upcoming events'", async () => {
    stubFetch(NEVER_SYNCED);
    wrap(<UpcomingEventsList hours={24} minImpact="MEDIUM" />);
    await waitFor(() => expect(screen.getByTestId("upcoming-events-not-covered")).toBeTruthy());
    expect(screen.getByTestId("upcoming-events-not-covered").textContent).toMatch(/never been synced/);
    expect(screen.queryByText(/No upcoming events/)).toBeNull();
  });

  it("HighImpactEventBanner says the next hour was not checked", async () => {
    stubFetch(NEVER_SYNCED);
    wrap(<HighImpactEventBanner />);
    await waitFor(() => expect(screen.getByTestId("high-impact-banner-not-checked")).toBeTruthy());
    expect(screen.getByTestId("high-impact-banner-not-checked").textContent).toMatch(/not checked/);
  });

  it("NewsRiskCard does not show CLEAR from an uncovered calendar", async () => {
    stubFetch(NEVER_SYNCED);
    wrap(<NewsRiskCard symbol="EURUSD" />);
    await waitFor(() => expect(screen.getByTestId("news-risk-not-checked")).toBeTruthy());
    expect(screen.queryByText("CLEAR")).toBeNull();
    expect(screen.getByTestId("news-risk-calendar-not-covered").textContent).toMatch(/cannot be ruled out/);
  });
});

describe("stored calendar covering the window", () => {
  it("UpcomingEventsList keeps the plain empty state", async () => {
    stubFetch(COVERED);
    wrap(<UpcomingEventsList hours={24} minImpact="MEDIUM" />);
    await waitFor(() => expect(screen.getByText(/No upcoming events in the next 24h/)).toBeTruthy());
    expect(screen.queryByTestId("upcoming-events-not-covered")).toBeNull();
  });

  it("HighImpactEventBanner renders nothing", async () => {
    stubFetch(COVERED);
    const { container } = wrap(<HighImpactEventBanner />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe("");
  });

  it("NewsRiskCard shows CLEAR", async () => {
    stubFetch(COVERED);
    wrap(<NewsRiskCard symbol="EURUSD" />);
    await waitFor(() => expect(screen.getByText("CLEAR")).toBeTruthy());
    expect(screen.queryByTestId("news-risk-not-checked")).toBeNull();
  });
});
