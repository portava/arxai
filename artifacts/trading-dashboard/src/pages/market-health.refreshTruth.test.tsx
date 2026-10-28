import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// Regressions on the Market Data Provider card:
//  - Refresh counted every probe with ok:true as "live", including DELAYED
//    quotes ("Refreshed — 3 live probe(s) succeeded.").
//  - A non-OK status response cleared the card back to "Loading provider
//    status…" forever, so a failure looked like a load in progress.

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

describe("Market Health refresh and status-error truth", () => {
  it("refresh does not count delayed quotes as live probes", async () => {
    const attempts = [
      { symbol: "EURUSD", ok: true, freshness: "DELAYED", reason: null },
      { symbol: "XAUUSD", ok: true, freshness: "DELAYED", reason: null },
      { symbol: "GBPUSD", ok: true, freshness: "REALTIME", reason: null },
    ];
    stubFetch(
      { ok: true, status: 200, body: { status: status() } },
      { ok: true, status: 200, body: { ok: true, attempts, status: status({ dataFreshness: "DELAYED" }) } },
    );
    render(<MarketHealthPage />);
    await screen.findByTestId("badge-provider-freshness");
    fireEvent.click(screen.getByRole("button", { name: /Refresh provider/i }));
    const msg = await screen.findByTestId("provider-refresh-message");
    expect(msg.textContent).not.toMatch(/3 live probe/);
    expect(msg.textContent).toMatch(/1 real-time/);
    expect(msg.textContent).toMatch(/2 delayed/);
  });

  it("a failed status response is shown as an error, not as loading", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "boom" } });
    render(<MarketHealthPage />);
    const err = await screen.findByTestId("provider-status-error");
    expect(err.textContent).toMatch(/could not be read/i);
    expect(err.textContent).toMatch(/500/);
    expect(screen.queryByText("Loading provider status…")).toBeNull();
  });
});
