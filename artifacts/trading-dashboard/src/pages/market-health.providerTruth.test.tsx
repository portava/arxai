import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// Regressions on the Market Data Provider card:
//  - freshnessState is FRESH after ANY successful provider call, so the badge
//    read FRESH while the last quote payload was DELAYED (or no quote was
//    fetched at all — only news), and "Connected: yes" echoed the adapter's
//    constant `connected: true`, never a measured connection.

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({ truth: null, feedStatus: null, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({ FeedConfidenceBadge: () => null }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: unknown }) => children }));

import MarketHealthPage from "./market-health";

const nowIso = () => new Date().toISOString();
function status(over: Record<string, unknown> = {}) {
  return {
    provider: "twelve_data", connected: true, configured: true, freshnessState: "FRESH", stale: false,
    lastSuccessfulFetchAt: nowIso(), lastAttemptedFetchAt: nowIso(), lastError: null, lastErrorAt: null,
    staleAfterMs: 300_000, unavailableReason: null,
    features: { quotes: true, news: false, snapshots: false, economicCalendar: false, candles: true },
    setupHint: null, dataFreshness: "REALTIME", dataSource: "twelve_data", dataFreshnessAt: nowIso(),
    ...over,
  };
}

type Resp = { ok: boolean; status: number; body: unknown };
function stubFetch(statusResp: Resp, refreshResp?: Resp) {
  global.fetch = vi.fn((url: string) => {
    const r = String(url).includes("/refresh") && refreshResp ? refreshResp : statusResp;
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) } as Response);
  }) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Market Health provider card truth", () => {
  it("a recent real-time quote reads FRESH", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status() } });
    render(<MarketHealthPage />);
    expect((await screen.findByTestId("badge-provider-freshness")).textContent).toBe("FRESH");
  });

  it("a DELAYED last quote is not badged FRESH", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ dataFreshness: "DELAYED", dataSource: "polygon" }) } });
    render(<MarketHealthPage />);
    const badge = await screen.findByTestId("badge-provider-freshness");
    expect(badge.textContent).not.toBe("FRESH");
    expect(badge.textContent).toMatch(/DELAYED/);
  });

  it("a success with no quote observed (news only) is not badged FRESH", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ dataFreshness: null, dataSource: null, dataFreshnessAt: null }) } });
    render(<MarketHealthPage />);
    const badge = await screen.findByTestId("badge-provider-freshness");
    expect(badge.textContent).not.toBe("FRESH");
    expect(badge.textContent).toMatch(/NO RECENT QUOTE/);
  });

  it("an old real-time observation behind a recent non-quote success is not FRESH", async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    stubFetch({ ok: true, status: 200, body: { status: status({ dataFreshnessAt: old }) } });
    render(<MarketHealthPage />);
    expect((await screen.findByTestId("badge-provider-freshness")).textContent).not.toBe("FRESH");
  });

  it("a candle fetch is not presented as the last quote", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ dataKind: "candles" }) } });
    render(<MarketHealthPage />);
    const card = await screen.findByTestId("card-market-data-provider");
    await screen.findByTestId("badge-provider-freshness");
    expect(within(card).queryByText("Last quote")).toBeNull();
    expect(within(card).getByText("Last candles")).toBeTruthy();
  });

  it("a real-time quote observation is labelled as a quote and names its source", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ dataKind: "quote", dataSource: "finnhub" }) } });
    render(<MarketHealthPage />);
    const card = await screen.findByTestId("card-market-data-provider");
    expect((await screen.findByTestId("badge-provider-freshness")).textContent).toBe("FRESH");
    expect(within(card).getByText("Last quote")).toBeTruthy();
    expect(within(card).getByTestId("provider-last-quote").textContent).toMatch(/real-time.*finnhub/);
  });

  it("a served quote whose own timestamp is stale reads STALE, not FRESH or 'no price data'", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ dataFreshness: "STALE", dataKind: "quote", dataSource: "finnhub" }) } });
    render(<MarketHealthPage />);
    expect((await screen.findByTestId("badge-provider-freshness")).textContent).toBe("STALE");
    expect(screen.getByTestId("provider-last-quote").textContent).toMatch(/stale/);
  });

  it("does not present the adapter's constant connected flag as a measured connection", async () => {
    stubFetch({ ok: true, status: 200, body: { status: status({ freshnessState: "ERROR", lastSuccessfulFetchAt: null, lastError: "ECONNREFUSED", lastErrorAt: nowIso(), dataFreshness: null, dataFreshnessAt: null }) } });
    render(<MarketHealthPage />);
    const card = await screen.findByTestId("card-market-data-provider");
    await screen.findByTestId("badge-provider-freshness");
    expect(within(card).queryByText("Connected")).toBeNull();
    expect(within(card).getByTestId("provider-responding").textContent).toMatch(/no/i);
  });

});
