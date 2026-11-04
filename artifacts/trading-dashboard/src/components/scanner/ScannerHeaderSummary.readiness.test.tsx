// Trade-Health readiness prominence (B7) — the Scanner header must surface the
// EXISTING shared Trade-Health readiness verdict (`ScannerTruth.readiness`, the
// Trade-Health contract) as a prominent, compact chip, and its tone must
// HONESTLY reflect that verdict.
//
// This is a TRUE render proof, not a source scan:
//   • the verdict fed to the header is produced by the REAL contract evaluator
//     (`evaluateTradeHealthReadiness`) — the header has NO other source for
//     `displayLabel` / `userFacingTrustLine`, so seeing that exact label proves
//     the chip reads the existing readiness verdict and derives nothing new;
//   • the CORE RULE is asserted directly: only a genuinely LIVE_CONFIRMED read
//     may carry the emphasised success (green + ring) treatment, and a weaker
//     read (historical / awaiting / blocked) may NOT — so a stale/weak read can
//     never be dressed up to look more trade-ready than it is.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { evaluateTradeHealthReadiness } from "@workspace/domain/market";
import { resolveScannerTruth, type ScannerTruth } from "@/lib/scannerTruth";

// The readiness verdict under test — swapped per-case, built by the REAL
// evaluator so we never hand-fake an impossible field combination.
let currentReadiness: ScannerTruth["readiness"] = liveConfirmed();

// A live-confirmed read: approved market + LIVE feed + enough closed bars + FULL
// read layer → the ONLY state that earns the emphasised success treatment.
function liveConfirmed(): ScannerTruth["readiness"] {
  return evaluateTradeHealthReadiness({
    symbol: "EURUSD",
    timeframe: "15m",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
    readLayer: "FULL",
    structureConfidence: "HIGH",
  });
}

// A closed-candle-only structural read: bars present but the feed is NOT
// confirmed for live entry → "Historical read only", must stay honest (warning),
// never green.
function historicalOnly(): ScannerTruth["readiness"] {
  return evaluateTradeHealthReadiness({
    symbol: "EURUSD",
    timeframe: "15m",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
    readLayer: "STRUCTURAL_ONLY",
    structureConfidence: "MEDIUM",
  });
}

// A live-confirmed feed whose LIVE EXECUTION is gated by account checks →
// "Live read · execution gated". The feed itself IS live-confirmed, so this
// deliberately keeps the LIVE_CONFIRMED feed-quality treatment while the label
// carries the execution-gate honestly — the chip is a READ-QUALITY signal, not
// a decision/execution signal, and the label never claims the trade is ready.
function liveGateBlocked(): ScannerTruth["readiness"] {
  return evaluateTradeHealthReadiness({
    symbol: "EURUSD",
    timeframe: "15m",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 300,
    readLayer: "FULL",
    structureConfidence: "HIGH",
    executionGateBlocked: true,
  });
}

// A not-approved market → "Not available" (blocked) → danger, never green.
function blocked(): ScannerTruth["readiness"] {
  return evaluateTradeHealthReadiness({
    symbol: "NOT_A_REAL_MARKET_XYZ",
    timeframe: "15m",
    freshnessVerdict: "UNKNOWN",
    availableClosedCandles: 0,
    readLayer: "INSUFFICIENT",
  });
}

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live feed confirmed." },
      ruby: { detail: "" },
      trading: { verdict: "Enabled", detail: "" },
    },
    candles: { lastClose: 1.1, sourceTechnical: "test", count: 300, minRequired: 200, status: "CONFIRMED" },
    consolidated: {
      rubyReadStatus: "NO_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "Live data is confirmed.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "ARX market data." },
    readiness: currentReadiness,
  } as unknown as ScannerTruth;
}

// Stub ONLY the header's data hooks; the readiness verdict flows through the
// real truth object above.
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["15m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

// Imported AFTER the mocks so the component picks up the stubbed hooks.
import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

afterEach(() => {
  cleanup();
  currentReadiness = liveConfirmed();
});

describe("ScannerHeaderSummary — Trade-Health readiness chip (B7, display-only)", () => {
  it("surfaces the EXISTING readiness verdict's displayLabel + trust line from truth.readiness", () => {
    currentReadiness = liveConfirmed();
    render(<ScannerHeaderSummary running={false} />);

    const chip = screen.getByTestId("scanner-header-readiness");
    const label = screen.getByTestId("scanner-header-readiness-label");
    // The label is EXACTLY the contract verdict's displayLabel — the header has
    // no other source for it, proving it reads truth.readiness.
    expect(label.textContent).toBe(currentReadiness.displayLabel);
    expect(currentReadiness.displayLabel).toBe("Live-confirmed");
    // The trust line is the verdict's userFacingTrustLine verbatim.
    expect(screen.getByTestId("scanner-header-readiness-trust").textContent).toBe(
      currentReadiness.userFacingTrustLine,
    );
    expect(chip.textContent).toContain("Trade Health");
  });

  it("LIVE_CONFIRMED earns the emphasised success (green + ring) treatment", () => {
    currentReadiness = liveConfirmed();
    render(<ScannerHeaderSummary running={false} />);

    const chip = screen.getByTestId("scanner-header-readiness");
    const label = screen.getByTestId("scanner-header-readiness-label");
    expect(label.className).toContain("text-success");
    expect(chip.className).toContain("bg-success/10");
    expect(chip.className).toContain("ring-success/20");
  });

  it("HISTORICAL_ONLY reads honestly (warning) and NEVER the green success treatment", () => {
    currentReadiness = historicalOnly();
    render(<ScannerHeaderSummary running={false} />);

    const chip = screen.getByTestId("scanner-header-readiness");
    const label = screen.getByTestId("scanner-header-readiness-label");
    expect(label.textContent).toBe(currentReadiness.displayLabel);
    expect(currentReadiness.displayLabel).toBe("Historical read only");
    // Honesty: warning tone, and NOT dressed up as trade-ready.
    expect(label.className).toContain("text-warning");
    expect(label.className).not.toContain("text-success");
    expect(chip.className).not.toContain("bg-success/10");
    expect(chip.className).not.toContain("ring-success/20");
    expect(chip.className).not.toContain("text-success");
  });

  it("execution-gated-but-live-confirmed read keeps the live feed-quality tone with an honest gated label", () => {
    currentReadiness = liveGateBlocked();
    render(<ScannerHeaderSummary running={false} />);

    const chip = screen.getByTestId("scanner-header-readiness");
    const label = screen.getByTestId("scanner-header-readiness-label");
    // The feed IS live-confirmed, so the feed-quality tone stays green — but the
    // label itself carries the execution gate, so nothing claims trade-ready.
    expect(label.textContent).toBe(currentReadiness.displayLabel);
    expect(currentReadiness.displayLabel).toBe("Live read · execution gated");
    expect(label.className).toContain("text-success");
    expect(chip.className).toContain("ring-success/20");
  });

  it("adapter-driven: a frozen account on a clean live 1m read shows the gated label from resolveScannerTruth (owner screenshot 2026-10-27)", () => {
    const NOW = Date.parse("2026-10-27T16:02:00.000Z");
    const t = resolveScannerTruth({
      symbolDisplay: "V75",
      symbolInternal: "V75",
      timeframe: "1m",
      feedStatus: {
        symbol: "V75", displaySymbol: "V75", assetClass: "synthetic", source: "deriv",
        isLive: true, lastTickTime: new Date(NOW).toISOString(), lastCandleTime: new Date(NOW).toISOString(),
        latencyMs: 100, missing: 0, duplicate: 0, outOfOrder: 0, invalidOhlc: 0, stale: false,
        quality: "clean", warning: null, aiUsable: true, feedReadinessState: "ready", message: "ok",
      } as unknown as Parameters<typeof resolveScannerTruth>[0]["feedStatus"],
      candleCount: 200,
      requestedCount: 200,
      firstTime: new Date(NOW - 200 * 60_000).toISOString(),
      lastTime: new Date(NOW - 10_000).toISOString(),
      lastClose: 33588.01,
      quote: null,
      headerOk: null,
      mode: {
        isLoading: false, isDemo: true, isLiveShared: false, isPaper: false, isLiveArmed: false,
        isFrozen: true, canManualTrade: true, canAutoTrade: false, isSharedMasterAssigned: false,
        ownBridgeConnected: false, approvalStatus: null,
        frozenReason: "Trading is restricted on your account.", cleanBlockedReason: null,
      },
      nowMs: NOW,
    });
    expect(t.strip.trading.verdict).toBe("Blocked");
    currentReadiness = t.readiness;
    render(<ScannerHeaderSummary running={false} />);
    expect(screen.getByTestId("scanner-header-readiness-label").textContent).toBe(
      "Live read · execution gated",
    );
    expect(screen.getByTestId("scanner-header-readiness-trust").textContent).toBe(
      "Live-confirmed 1m read — live execution is currently gated by your account checks.",
    );
  });

  it("a blocked (not-available) read shows danger tone, never green", () => {
    currentReadiness = blocked();
    render(<ScannerHeaderSummary running={false} />);

    const chip = screen.getByTestId("scanner-header-readiness");
    const label = screen.getByTestId("scanner-header-readiness-label");
    expect(label.textContent).toBe(currentReadiness.displayLabel);
    expect(currentReadiness.displayLabel).toBe("Not available");
    expect(label.className).toContain("text-danger");
    expect(chip.className).not.toContain("bg-success/10");
    expect(chip.className).not.toContain("ring-success/20");
  });
});
