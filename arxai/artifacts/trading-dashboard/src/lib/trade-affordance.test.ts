import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  resolveScannerTruth,
  type ScannerTruthInputs,
  type ScannerTruthMode,
} from "./scannerTruth";
import { resolveTradeAffordance } from "./trade-affordance";
import { resolveScannerActionability } from "./scannerActionability";
import { evaluateTradeHealthReadiness } from "@workspace/domain/market";

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "twelvedata",
    isLive: true,
    lastTickTime: new Date(NOW).toISOString(),
    lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    invalidOhlc: 0,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    feedReadinessState: "ready",
    message: "ok",
    ...over,
  } as ChartFeedStatus;
}

function mode(over: Partial<ScannerTruthMode> = {}): ScannerTruthMode {
  return {
    isLoading: false,
    isDemo: true,
    isLiveShared: false,
    isPaper: false,
    isLiveArmed: false,
    isFrozen: false,
    canManualTrade: true,
    canAutoTrade: false,
    isSharedMasterAssigned: false,
    ownBridgeConnected: false,
    approvalStatus: null,
    frozenReason: null,
    cleanBlockedReason: null,
    ...over,
  };
}

function inputs(over: Partial<ScannerTruthInputs> = {}): ScannerTruthInputs {
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: "1m",
    feedStatus: feed(),
    candleCount: 200,
    requestedCount: 200,
    firstTime: new Date(NOW - 200 * 60_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.15059,
    quote: null,
    headerOk: null,
    mode: mode(),
    nowMs: NOW,
    ...over,
  };
}

// Tokens that must NEVER reach a user-facing warning string.
const FORBIDDEN = [
  "assistant_real", "twelvedata", "twelve_data", "polygon", "alpha_vantage",
  "alphavantage", "aiusable", "feedstatus", "mt5provider", "mt5_provider",
  "sourcetechnical",
];

describe("resolveTradeAffordance — never blocks, honest when not live", () => {
  it("returns nothing while truth is still loading (null)", () => {
    const a = resolveTradeAffordance(null, "demo");
    // No truth → no warning AND no display ceiling (every flag fail-closed).
    expect(a.requireAck).toBe(false);
    expect(a.warningTitle).toBe("");
    expect(a.warningDetail).toBe("");
    expect(a.readinessLabel).toBe("");
    expect(a.readinessTrustLine).toBe("");
    expect(a.mayDescribeSetup).toBe(false);
    expect(a.mayShowTradeButton).toBe(false);
    expect(a.mayShowOneClickButton).toBe(false);
    expect(a.mayOfferLiveExecutionRequest).toBe(false);
  });

  it("read_only mode never warns or acks (no trade buttons render)", () => {
    const stale = resolveScannerTruth(inputs({ feedStatus: feed({ stale: true }) }));
    expect(stale.actionable).toBe(false);
    const a = resolveTradeAffordance(stale, "read_only");
    expect(a.requireAck).toBe(false);
    expect(a.warningTitle).toBe("");
    // read_only forces EVERY display ceiling off, even if the read would allow it.
    expect(a.mayDescribeSetup).toBe(false);
    expect(a.mayShowTradeButton).toBe(false);
    expect(a.mayShowOneClickButton).toBe(false);
    expect(a.mayOfferLiveExecutionRequest).toBe(false);
  });

  it("a genuinely live, actionable read → no warning, no ack (demo AND live)", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.actionable).toBe(true);
    for (const td of ["demo", "live"] as const) {
      const a = resolveTradeAffordance(t, td);
      expect(a.requireAck).toBe(false);
      expect(a.warningTitle).toBe("");
      expect(a.warningDetail).toBe("");
    }
  });

  it("GBPUSD case: live via third-party (not broker) is actionable → still NO friction", () => {
    // Live, fresh, sufficient candles from a third-party (non-broker) feed.
    const t = resolveScannerTruth(inputs({ symbolDisplay: "GBPUSD", symbolInternal: "GBPUSD", feedStatus: feed({ source: "twelvedata" }) }));
    expect(t.actionable).toBe(true);
    expect(t.brokerFeedActive).toBe(false); // honesty handled by dataHealth, not friction
    expect(resolveTradeAffordance(t, "live").warningTitle).toBe("");
    expect(resolveTradeAffordance(t, "demo").requireAck).toBe(false);
  });

  it("stale read → demo requires an ack; live warns but never acks (one-click stays frictionless)", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ stale: true }) }));
    expect(t.actionable).toBe(false);

    const demo = resolveTradeAffordance(t, "demo");
    expect(demo.requireAck).toBe(true);
    expect(demo.warningTitle.length).toBeGreaterThan(0);
    expect(demo.warningDetail.length).toBeGreaterThan(0);

    const live = resolveTradeAffordance(t, "live");
    expect(live.requireAck).toBe(false); // live is never ack-gated by this helper
    expect(live.warningTitle.length).toBeGreaterThan(0);
    expect(live.warningDetail).toBe(demo.warningDetail);
  });

  it("insufficient candles (historical-only) → warns and acks in demo", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 40 }));
    expect(t.actionable).toBe(false);
    const demo = resolveTradeAffordance(t, "demo");
    expect(demo.requireAck).toBe(true);
    expect(demo.warningTitle).toContain("Historical");
  });

  it("unavailable feed → warns (no data to act on)", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 0, feedStatus: feed({ isLive: false, stale: true, quality: "unavailable" }) }));
    expect(t.actionable).toBe(false);
    const a = resolveTradeAffordance(t, "demo");
    expect(a.warningTitle.length).toBeGreaterThan(0);
  });

  it("warning strings never leak a provider token or internal flag name", () => {
    for (const over of [{ stale: true }, { source: "polygon", stale: true }, { source: "alphavantage", stale: true }] as Partial<ChartFeedStatus>[]) {
      const t = resolveScannerTruth(inputs({ feedStatus: feed(over) }));
      for (const td of ["demo", "live"] as const) {
        const a = resolveTradeAffordance(t, td);
        const blob = `${a.warningTitle} ${a.warningDetail}`.toLowerCase();
        for (const tok of FORBIDDEN) {
          expect(blob.includes(tok), `affordance copy leaked "${tok}"`).toBe(false);
        }
      }
    }
  });
});

// ── T004: ONE shared Trade-Health verdict across every surface ────────────────
//
// The contract's purpose is that the scanner, Ruby, the chart, the trade ticket,
// and the AI-setup card can NEVER contradict each other for the same
// symbol+timeframe, AND that a confident DISPLAY read can never make a ticket
// executable. These deterministic tests lock both guarantees at the shared layer.

describe("Trade-Health contract — cross-surface label consistency", () => {
  it("the trade-affordance hub mirrors truth.readiness EXACTLY (no second opinion)", () => {
    // Every trade surface that consults resolveTradeAffordance must show the SAME
    // label/trust line + the SAME ceilings as the scanner's own readiness verdict.
    for (const over of [
      {},
      { feedStatus: feed({ stale: true }) },
      { candleCount: 40 },
      { candleCount: 0, feedStatus: feed({ isLive: false, stale: true, quality: "unavailable" }) },
    ] as Partial<ScannerTruthInputs>[]) {
      const t = resolveScannerTruth(inputs(over));
      // demo / live: the hub surfaces the contract verbatim.
      for (const td of ["demo", "live"] as const) {
        const a = resolveTradeAffordance(t, td);
        expect(a.readinessLabel).toBe(t.readiness.displayLabel);
        expect(a.readinessTrustLine).toBe(t.readiness.userFacingTrustLine);
        expect(a.mayDescribeSetup).toBe(t.readiness.mayDescribeSetup);
        expect(a.mayShowTradeButton).toBe(t.readiness.mayShowTradeButton);
        expect(a.mayShowOneClickButton).toBe(t.readiness.mayShowOneClickButton);
        expect(a.mayOfferLiveExecutionRequest).toBe(t.readiness.mayOfferLiveExecutionRequest);
      }
    }
  });

  it("the scanner readiness equals a direct (Ruby-style) contract evaluation for identical inputs", () => {
    // Scanner composes evaluateTradeHealthReadiness; Ruby composes the SAME pure
    // contract. Identical inputs ⇒ identical user-facing trust line + ceilings, so
    // the two surfaces can never disagree. We reproduce the scanner's exact mapping
    // for a clean, live, sufficient EURUSD 1m read.
    const t = resolveScannerTruth(inputs());
    const direct = evaluateTradeHealthReadiness({
      symbol: "EURUSD",
      timeframe: "1m",
      freshnessVerdict: "LIVE",
      availableClosedCandles: t.candles.count,
      minimumRequiredCandles: t.candles.minRequired,
      readLayer: "FULL",
    });
    expect(t.readiness.userFacingTrustLine).toBe(direct.userFacingTrustLine);
    expect(t.readiness.displayLabel).toBe(direct.displayLabel);
    expect(t.readiness.mayDescribeSetup).toBe(direct.mayDescribeSetup);
    expect(t.readiness.mayShowTradeButton).toBe(direct.mayShowTradeButton);
  });

  it("identical inputs are deterministic (same trust line every call)", () => {
    const a = resolveTradeAffordance(resolveScannerTruth(inputs()), "live");
    const b = resolveTradeAffordance(resolveScannerTruth(inputs()), "live");
    expect(a).toEqual(b);
  });
});

describe("Trade-Health contract — display NEVER grants execution", () => {
  it("a NOT-live-confirmed read withholds the trade/one-click ceilings", () => {
    // Stale feed → not live-confirmed → no display affordance may show, on any mode.
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ stale: true }) }));
    for (const td of ["demo", "live", "read_only"] as const) {
      const a = resolveTradeAffordance(t, td);
      expect(a.mayDescribeSetup).toBe(false);
      expect(a.mayShowTradeButton).toBe(false);
      expect(a.mayShowOneClickButton).toBe(false);
      expect(a.mayOfferLiveExecutionRequest).toBe(false);
    }
  });

  it("a live-confirmed DISPLAY read does NOT change the ack/warning (canTrade stays sole authority)", () => {
    // Even when the read is fully live-confirmed (ceilings true), the helper adds
    // NO friction and — crucially — exposes nothing that ENABLES a trade. The
    // ceilings are display-only; the ticket's Confirm is gated elsewhere (canTrade
    // + the backend 18-gate pipeline), which this helper never touches.
    const t = resolveScannerTruth(inputs());
    expect(t.actionable).toBe(true);
    const live = resolveTradeAffordance(t, "live");
    expect(live.requireAck).toBe(false);
    expect(live.warningTitle).toBe("");
    // The object exposes only display fields — no canTrade / enable / disabled key.
    expect(Object.keys(live).sort()).toEqual(
      [
        "mayDescribeSetup",
        "mayOfferLiveExecutionRequest",
        "mayShowOneClickButton",
        "mayShowTradeButton",
        "readinessLabel",
        "readinessTrustLine",
        "requireAck",
        "warningDetail",
        "warningTitle",
      ].sort(),
    );
  });

  it("read_only caps the ceilings off even when the underlying read is live-confirmed", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.readiness.mayShowTradeButton).toBe(true); // the read itself qualifies
    const ro = resolveTradeAffordance(t, "read_only");
    expect(ro.mayShowTradeButton).toBe(false); // …but read_only forces it off
    expect(ro.mayShowOneClickButton).toBe(false);
    expect(ro.mayOfferLiveExecutionRequest).toBe(false);
    // The honest read-quality label still surfaces (it's read honesty, not a button).
    expect(ro.readinessTrustLine.length).toBeGreaterThan(0);
  });
});

describe("resolveScannerActionability — readiness ceiling is downgrade-only", () => {
  const cleanData = {
    quoteStatus: "LIVE",
    candleStatus: "CONFIRMED",
    chartIntelligenceStatus: "FULL",
  } as const;

  it("a READY setup downgrades to WAIT when the ceiling withholds the trade button", () => {
    expect(resolveScannerActionability(cleanData, "READY")).toBe("READY_NOW");
    expect(
      resolveScannerActionability(cleanData, "READY", { mayShowTradeButton: false }),
    ).toBe("WAIT_FOR_CONFIRMATION");
    // Ceiling that permits the button leaves READY_NOW intact.
    expect(
      resolveScannerActionability(cleanData, "READY", { mayShowTradeButton: true }),
    ).toBe("READY_NOW");
  });

  it("the ceiling NEVER upgrades a non-READY verdict", () => {
    for (const setup of ["WAIT", "TOO_LATE", "NO_CLEAN_SETUP", "UNKNOWN"] as const) {
      const base = resolveScannerActionability(cleanData, setup);
      const withCeiling = resolveScannerActionability(cleanData, setup, {
        mayShowTradeButton: true,
      });
      expect(withCeiling).toBe(base); // a permissive ceiling can't promote anything
    }
  });

  it("the data cap still dominates the ceiling (feed honesty wins)", () => {
    const closed = { ...cleanData, quoteStatus: "MARKET_CLOSED" } as const;
    expect(
      resolveScannerActionability(closed, "READY", { mayShowTradeButton: true }),
    ).toBe("MARKET_CLOSED");
  });
});
