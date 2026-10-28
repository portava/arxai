// Regression (truth audit): a lifted scalp verdict must never override the
// selected chart's CURRENT data cap, must not outlive the scalp result's own
// expiresAt, and the direction word may not contradict the scalp's own side.
//
// Before the fix the header's Action pill read "Buy now" / "Ready now" — with
// the copy "Live data is confirmed and the setup is ready" — while the chart
// truth for the same symbol+timeframe had degraded to stale (FEED_LIMITED),
// because `resolveSelectedSymbolActionability` returned `lifted ?? dataOnly`
// with no severity comparison, the lifted value had no expiry, and the side
// came from the composed bias rather than the scalp's own direction.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, act } from "@testing-library/react";
import { PENDING_RESOLVE_TIMEOUT_MS } from "@/lib/scannerActionability";

import type { ScalpResult } from "@workspace/api-client-react";
import { resolveScannerTruth, type ScannerTruth } from "@/lib/scannerTruth";

// ── Controllable selected timeframe (the variable under test) ────────────────
// The bus form of the timeframe the Focus scalp engine reads (server M5).
const SCALP_TF = "5m";
let currentTimeframe = SCALP_TF;

// ── Controllable selected symbol + scalp resolve (cold-start proof) ──────────
let currentSymbol = "EURUSD";
// When false, the scalp mutation never resolves — simulating the in-flight
// window right after a symbol switch (the cold-start gap under test).
let scalpResolves = true;
// When true, the scalp mutation errors — simulating a failed setup check.
let scalpFails = false;
// When false, the symbol+timeframe-keyed truth read has not resolved yet
// (mid-switch / first load) — the ONLY window in which the header may show
// the neutral PENDING ("Checking…") state.
let truthLoaded = true;
// The chart truth for the selected key: live, or degraded to stale.
let feedStale = false;
// The composed snapshot verdict (bias) the header reads its direction from.
let currentVerdict: { bias: string } | null = null;

const NOW = Date.now();
function currentTruth(): ScannerTruth {
  return resolveScannerTruth({
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: SCALP_TF,
    feedStatus: {
      symbol: "EURUSD",
      displaySymbol: "EUR/USD",
      assetClass: "forex",
      source: "mt5_broker",
      isLive: !feedStale,
      lastTickTime: new Date(NOW).toISOString(),
      lastCandleTime: new Date(NOW).toISOString(),
      latencyMs: 100,
      missing: 0,
      duplicate: 0,
      outOfOrder: 0,
      invalidOhlc: 0,
      stale: feedStale,
      quality: feedStale ? "stale" : "clean",
      warning: null,
      aiUsable: !feedStale,
      feedReadinessState: "ready",
      message: "ok",
    } as never,
    candleCount: 300,
    requestedCount: 300,
    firstTime: new Date(NOW - 300 * 300_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.1,
    quote: null,
    headerOk: null,
    mode: {
      isLoading: false, isDemo: true, isLiveShared: false, isPaper: false, isLiveArmed: false,
      isFrozen: false, canManualTrade: true, canAutoTrade: false, isSharedMasterAssigned: false,
      ownBridgeConnected: false, approvalStatus: null, frozenReason: null, cleanBlockedReason: null,
    },
    nowMs: NOW,
  });
}
// When set, the scalp mutation resolves THIS result instead of the READY one.
let scalpOverride: Partial<ScalpResult> | null = null;

// The scalp result the Focus card resolves. Built inside vi.hoisted so the
// (hoisted) api-client mock factory can reference it without a TDZ error. A
// clean, READY result → the engine yields the READY_NOW verdict ("Ready now")
// the header should adopt ONLY on the timeframe the scalp card actually read.
const { scalpResult } = vi.hoisted(() => {
  const flame = {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 80,
    flameStage: "RUN_ON",
    flameAgeCandles: 3,
    freshness: "FRESH",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "CONTINUATION",
    riskPersonality: "BALANCED",
    whyNow: null,
    entryTrigger: null,
    targetIdea: null,
    invalidationIdea: null,
    decayNote: null,
    blind: false,
  };
  const result = {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "BUY",
    scalpType: "Momentum",
    mode: "ANY",
    status: "READY",
    timeframe: "M5",
    qualityScore: 80,
    confidenceLabel: "Strong",
    entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 },
    currentPrice: 1.1002,
    takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099,
    invalidationPrice: 1.0985,
    suggestedLot: 0.1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    digits: 5,
    targetProfitAmount: 20,
    estimatedProfitMainTP: 20,
    estimatedRiskAmount: 10,
    rewardToRisk: 2,
    estimatedMargin: 100,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: "LOW",
    timingStatus: "VALID_NOW",
    validForSeconds: 90,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    chaseWarning: null,
    plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null,
    targetRealityCheck: "REALISTIC",
    userAction: "READY_TO_REVIEW",
    canBuildTrade: true,
    canWatch: true,
    noTradeReason: null,
    flame,
    generatedAt: new Date().toISOString(),
  };
  return { scalpResult: result };
});

// ── Stub ONLY the header's data hooks; the store + coercion stay real ────────
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => [currentSymbol, () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => [currentTimeframe, () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  // The real hook is keyed by symbol+timeframe with no keepPreviousData:
  // `scannerTruth` is null exactly while the current key's read is in flight,
  // and ALWAYS the current key's resolved read when present. `truthLoaded`
  // models that gap.
  useSymbolTruth: () => ({ scannerTruth: truthLoaded ? currentTruth() : null, verdict: currentVerdict }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

// The Focus card's scalp read — override the mutation hook to resolve instantly
// with the READY result, keeping every OTHER api-client export real (the header
// reads TruthVerdict* enums from the same module).
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateMeScalpFocus: () => ({
      mutate: (
        vars: { data?: { symbol?: string } },
        opts?: { onSuccess?: (d: ScalpResult) => void; onError?: (e: Error) => void },
      ) => {
        if (scalpFails) opts?.onError?.(new Error("scalp read failed"));
        else if (scalpResolves) {
          // Echo the REQUESTED symbol back (like the real API): the card
          // publishes under r.symbol, so a frozen symbol would trip the
          // stale-symbol guard on every switch.
          opts?.onSuccess?.({
            ...(scalpResult as ScalpResult),
            ...(scalpOverride ?? {}),
            symbol: vars?.data?.symbol ?? (scalpResult as ScalpResult).symbol,
          } as ScalpResult);
        }
      },
      isPending: false,
      isError: false,
    }),
  };
});

// Imported AFTER the mocks so the components pick up the stubbed hooks.
import { RubyScalpFocusCard } from "./RubyScalpFocusCard";
import { ScannerHeaderSummary } from "./ScannerHeaderSummary";
import { SelectedActionStoreProvider } from "./selectedActionStore";

function tree() {
  return (
    <SelectedActionStoreProvider>
      <RubyScalpFocusCard symbol="EURUSD" />
      <ScannerHeaderSummary running={false} />
    </SelectedActionStoreProvider>
  );
}

async function pillText(): Promise<string> {
  const pill = await screen.findByTestId("scanner-header-action");
  return pill.textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  feedStale = false;
  currentVerdict = null;
  scalpOverride = null;
  truthLoaded = true;
  scalpResolves = true;
  scalpFails = false;
});

describe("ScannerHeaderSummary — lifted scalp verdict is capped by the current chart truth", () => {
  it("control: live chart truth + READY scalp → Ready now", async () => {
    render(tree());
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Ready now")).toBeTruthy();
  });

  it("stale chart truth (FEED_LIMITED) dominates a lifted READY_NOW", async () => {
    feedStale = true;
    expect(currentTruth().consolidated.scannerActionability).toBe("FEED_LIMITED");
    render(tree());
    const text = await pillText();
    expect(text).not.toContain("Ready now");
    expect(text).not.toMatch(/now/);
    expect(document.body.textContent ?? "").not.toContain("Live data is confirmed and the setup is ready");
    expect(text).toContain("Feed limited");
  });

  it("a lifted READY_NOW stops showing once the scalp result's expiresAt passes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scalpOverride = {
      validForSeconds: 30,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    render(tree());
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Ready now")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    const text = await pillText();
    expect(text).not.toContain("Ready now");
    // Falls back to the current data-only verdict for this key.
    expect(text).toContain("Wait for confirmation");
  });

  it("an already-expired scalp result is never lifted", async () => {
    scalpOverride = {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    render(tree());
    const text = await pillText();
    expect(text).not.toContain("Ready now");
  });

  it("the side word never contradicts the scalp's own direction (bias BULLISH, scalp SELL)", async () => {
    currentVerdict = { bias: "BULLISH" };
    scalpOverride = { direction: "SELL", entryType: "MARKET_SELL" } as Partial<ScalpResult>;
    render(tree());
    const text = await pillText();
    expect(text).not.toContain("Buy now");
    expect(text).not.toContain("Sell now");
    expect(text).toContain("Ready now");
  });

  it("agreeing side keeps the directional label (bias BULLISH, scalp BUY)", async () => {
    currentVerdict = { bias: "BULLISH" };
    render(tree());
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Buy now")).toBeTruthy();
  });
});
