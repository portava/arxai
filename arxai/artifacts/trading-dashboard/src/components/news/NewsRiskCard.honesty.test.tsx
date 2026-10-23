// NewsRiskCard provider-honesty banner states.
//
// WHAT THIS LOCKS
//   A disconnected news/calendar provider must NEVER let the card read as a
//   confident all-clear. The card consumes the single market-heat
//   provider-status seam (GET /api/market-heat/diagnostics) and must render an
//   honest "absence of a warning is not an all-clear" banner in EVERY missing
//   -provider combination:
//     1. both news + calendar disconnected  → "Provider unavailable"
//     2. calendar disconnected (news up)     → "Calendar unavailable"
//     3. news disconnected (calendar up)     → "News unavailable"
//   …and render NO banner only when BOTH providers are connected.
//
//   The news-only-disconnected case (#3) was the honesty leak: `newsConnected`
//   was computed but never gated a standalone warning, so a disconnected news
//   provider could coexist with a reassuring risk label.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewsRiskCard } from "./NewsRiskCard";

type Provider = { kind: string; connected: boolean; name: string };

function mockFetch(providers: Provider[], report?: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/market-heat/diagnostics")) {
      return new Response(JSON.stringify({ providers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/news-risk/latest")) {
      // No report → keeps the card on its banner-only path.
      if (report === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(report), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NewsRiskCard symbol="EURUSD" />
    </QueryClientProvider>,
  );
}

const NEWS_UP: Provider = { kind: "news", connected: true, name: "finnhub" };
const NEWS_DOWN: Provider = { kind: "news", connected: false, name: "none" };
const CAL_UP: Provider = { kind: "calendar", connected: true, name: "tradingeconomics" };
const CAL_DOWN: Provider = { kind: "calendar", connected: false, name: "none" };

describe("NewsRiskCard provider-honesty banners", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch([]));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("both providers down → 'Provider unavailable' + not-an-all-clear", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_DOWN, CAL_DOWN]));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Provider unavailable/i)).toBeTruthy();
    });
    expect(screen.getByText(/not an all-clear/i)).toBeTruthy();
  });

  it("calendar down, news up → 'Calendar unavailable' + not-an-all-clear", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_UP, CAL_DOWN]));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Calendar unavailable/i)).toBeTruthy();
    });
    expect(screen.getByText(/not an all-clear/i)).toBeTruthy();
    expect(screen.queryByText(/Provider unavailable/i)).toBeNull();
  });

  it("news down, calendar up → 'News unavailable' + not-an-all-clear (the leak)", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_DOWN, CAL_UP]));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/News unavailable/i)).toBeTruthy();
    });
    expect(screen.getByText(/not an all-clear/i)).toBeTruthy();
    expect(screen.queryByText(/Provider unavailable/i)).toBeNull();
    expect(screen.queryByText(/Calendar unavailable/i)).toBeNull();
  });

  it("both providers connected → NO honesty banner", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_UP, CAL_UP]));
    renderCard();
    // Fail-closed default: while diagnostics load the card shows the honest
    // banner; once both providers resolve connected, every banner must clear.
    await waitFor(() => {
      expect(screen.queryByText(/not an all-clear/i)).toBeNull();
    });
    expect(screen.getByText(/News & Economic Risk/i)).toBeTruthy();
    expect(screen.queryByText(/Provider unavailable/i)).toBeNull();
    expect(screen.queryByText(/Calendar unavailable/i)).toBeNull();
    expect(screen.queryByText(/News unavailable/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Driving headlines — mirrors the Global Market Heat card treatment.
//   When per-symbol risk is elevated/high AND the news provider is positively
//   connected, the card lists the top severity-ranked headlines (headline +
//   source + age). A disconnected provider must surface NO headlines and never
//   fabricate one. Advisory-only: no execution affordance.
// ---------------------------------------------------------------------------
function reportWith(news: unknown, riskLevel = "HIGH_RISK") {
  return {
    id: 1,
    symbol: "EURUSD",
    relatedCurrency: "EUR",
    eventId: null,
    riskLevel,
    timeUntilEventMinutes: 12,
    tradeWarning: "High-impact event imminent",
    aiSummary: "Elevated event risk on EUR.",
    createdAt: new Date().toISOString(),
    news,
  };
}

const CONNECTED_NEWS = {
  connected: true,
  provider: "finnhub",
  itemCount: 2,
  highImpactCount: 1,
  topHeadlines: [
    {
      headline: "ECB signals surprise rate decision",
      source: "Reuters",
      publishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      severity: "high",
    },
    {
      headline: "EUR slips ahead of CPI print",
      source: "Bloomberg",
      publishedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      severity: "medium",
    },
  ],
};

describe("NewsRiskCard driving headlines", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("elevated risk + connected provider → lists severity-ranked headlines (headline + source)", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_UP, CAL_UP], reportWith(CONNECTED_NEWS)));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Driving headlines/i)).toBeTruthy();
    });
    expect(screen.getByText(/ECB signals surprise rate decision/i)).toBeTruthy();
    expect(screen.getByText(/EUR slips ahead of CPI print/i)).toBeTruthy();
    expect(screen.getByText(/Reuters/)).toBeTruthy();
    expect(screen.getByText(/Bloomberg/)).toBeTruthy();
  });

  it("disconnected provider → NO headlines section, none fabricated", async () => {
    const disconnected = {
      connected: false,
      provider: "none",
      itemCount: 0,
      highImpactCount: 0,
      topHeadlines: [],
      updatedAt: null,
    };
    vi.stubGlobal("fetch", mockFetch([NEWS_DOWN, CAL_UP], reportWith(disconnected)));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Elevated event risk on EUR/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Driving headlines/i)).toBeNull();
  });

  it("CLEAR risk → no headlines even when provider connected and headlines exist", async () => {
    vi.stubGlobal("fetch", mockFetch([NEWS_UP, CAL_UP], reportWith(CONNECTED_NEWS, "CLEAR")));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Elevated event risk on EUR/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Driving headlines/i)).toBeNull();
  });
});
