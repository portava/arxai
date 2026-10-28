import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { resolveScannerTruth, type ScannerTruth, type ScannerTruthMode } from "@/lib/scannerTruth";

// Market Health shows the resolved scanner verdict ("Stale" once the newest
// M15 bar is older than the client freshness budget) right beside the raw
// FeedConfidenceBadge. In the 1.2×–2× interval window the server feed status
// still says clean / isLive, so the same card read "Stale" and "Clean · Live"
// for one feed and one timestamp. The badge may only be downgraded to match
// the resolved truth.

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const LAST = new Date(NOW - 25 * 60_000).toISOString(); // M15 bar opened 25 min ago

const feedStatus = {
  symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "twelvedata",
  isLive: true, lastTickTime: LAST, lastCandleTime: LAST, latencyMs: 100,
  missing: 0, duplicate: 0, outOfOrder: 0, invalidOhlc: 0, missingCandleCount: 0,
  duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 1,
  stale: false, quality: "clean", warning: null, aiUsable: true, feedReadinessState: "ready", message: "ok",
} as unknown as ChartFeedStatus;

const mode: ScannerTruthMode = {
  isLoading: false, isDemo: true, isLiveShared: false, isPaper: false, isLiveArmed: false,
} as unknown as ScannerTruthMode;

let truth: ScannerTruth;

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({ truth, feedStatus, isLoading: false, isError: false, refetch: () => undefined }),
}));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const { default: MarketHealthPage } = await import("./market-health");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Market Health — data verdict and feed badge agree", () => {
  it("does not show 'Stale' beside a badge that says Clean / Live", async () => {
    truth = resolveScannerTruth({
      symbolDisplay: "EURUSD", symbolInternal: "EURUSD", timeframe: "M15", feedStatus,
      candleCount: 200, requestedCount: 200, firstTime: new Date(NOW - 200 * 15 * 60_000).toISOString(),
      lastTime: LAST, lastClose: 1.15059, quote: null, headerOk: null, mode, nowMs: NOW,
    });
    // Precondition: the resolved truth calls this bar stale.
    expect(truth.candles.status).toBe("stale");

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    render(<MarketHealthPage />);
    expect(screen.getByTestId("badge-data-verdict").textContent).toMatch(/stale/i);
    const badge = screen.getByTestId("arx-feed-badge");
    expect(badge.getAttribute("data-severity")).not.toBe("clean");
    expect(badge.textContent).not.toMatch(/Clean/);
    fireEvent.click(badge);
    const detail = await screen.findByTestId("arx-feed-detail");
    expect(detail.textContent).not.toMatch(/StateLive/);
  });
});
