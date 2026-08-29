// Regression locks for the ARX Scanner Truth Principle (computeFinalRead).
// Run via:
//   node --import tsx --test src/lib/__qa__/scannerTruthCaps.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scanner-truth-caps`)
//
// The truth caps may ONLY lower a read's label/confidence, never raise them.
// These tests lock: non-live data is never HIGH and never actionable
// (TRADE_WATCH), simulator floors to LOW, missing news/history is admitted
// honestly ("technicals-only"), conflicts downgrade, and chart-unconfirmed
// actionable reads are withheld. Pure & deterministic — no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalRead,
  type ScannerOpportunity,
  type ScannerNewsContext,
  type ScannerHistoricalContext,
} from "../marketScanner.js";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
    signalStrength: 88, // dual-emit alias — always equals confidenceScore
    confidenceScore: 88, // strong technical by default
    riskScore: 20,
    entrySniperScore: 80,
    riskRewardRatio: 2,
    reasonForTrade: "Support hold",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88,
      label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-06-07T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
    ...over,
  };
}

function news(over: Partial<ScannerNewsContext> = {}): ScannerNewsContext {
  return {
    riskLevel: "none",
    timing: "none",
    alignsWithScanner: null,
    ...over,
  } as ScannerNewsContext;
}

function hist(over: Partial<ScannerHistoricalContext> = {}): ScannerHistoricalContext {
  return {
    available: true,
    bias: "BULLISH",
    confidence: "HIGH",
    sampleSize: 40,
    winRate: 64,
    avgMovePct: 1.2,
    worstDrawdownPct: 0.6,
    alignsWithScanner: true,
    note: "",
    ...over,
  };
}

// ── Baseline: a fully-confirmed live read can reach the top ─────────────────

test("baseline: live + both feeds + clean => TRADE_WATCH / HIGH", () => {
  const r = computeFinalRead(opp({ newsContext: news(), historicalContext: hist() }));
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "HIGH");
});

// ── Non-live data: never HIGH, never actionable ─────────────────────────────

for (const ds of ["AWAITING_FEED", "HISTORY_READY_AWAITING_LIVE_TICK", "LIVE_DELAYED", "SIMULATOR"] as const) {
  test(`non-live (${ds}): never HIGH and never TRADE_WATCH`, () => {
    const r = computeFinalRead(opp({ dataSource: ds, newsContext: news(), historicalContext: hist() }));
    assert.notEqual(r.confidence, "HIGH", `${ds} must not be HIGH`);
    assert.notEqual(r.label, "TRADE_WATCH", `${ds} must not be actionable`);
  });
}

test("SIMULATOR floors confidence to LOW and says so plainly", () => {
  const r = computeFinalRead(opp({ dataSource: "SIMULATOR", newsContext: news(), historicalContext: hist() }));
  assert.equal(r.confidence, "LOW");
  assert.ok(
    r.reasons.some((x) => /simulated data|not a live feed/i.test(x)),
    "names the simulator honestly",
  );
});

test("LIVE_DELAYED floors to LOW with honest delayed copy distinct from awaiting/simulator", () => {
  const r = computeFinalRead(opp({ dataSource: "LIVE_DELAYED", newsContext: news(), historicalContext: hist() }));
  assert.equal(r.confidence, "LOW");
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.ok(
    r.reasons.some((x) => /latest candle is delayed/i.test(x)),
    "names the delayed-candle state honestly",
  );
  assert.ok(
    !r.reasons.some((x) => /simulated data|waiting for verified live/i.test(x)),
    "does not collapse into simulator/awaiting copy",
  );
});

// ── Honest uncertainty when feeds are missing ───────────────────────────────

test("no news and no history => LOW confidence, technicals-only admission", () => {
  const r = computeFinalRead(opp()); // no contexts attached
  assert.equal(r.confidence, "LOW");
  assert.ok(
    r.reasons.some((x) => /unavailable|technicals-only/i.test(x)),
    "admits feeds are unavailable",
  );
});

test("one feed missing => at most MEDIUM (never HIGH)", () => {
  const onlyNews = computeFinalRead(opp({ newsContext: news() }));
  assert.notEqual(onlyNews.confidence, "HIGH");
  const onlyHist = computeFinalRead(opp({ historicalContext: hist() }));
  assert.notEqual(onlyHist.confidence, "HIGH");
});

// ── News risk lowers the read ───────────────────────────────────────────────

test("critical news => NO_TRADE", () => {
  const r = computeFinalRead(opp({ newsContext: news({ riskLevel: "critical" }), historicalContext: hist() }));
  assert.equal(r.label, "NO_TRADE");
});

test("high news now => AVOID_FOR_NOW; medium => WAIT_FOR_CONFIRMATION", () => {
  const high = computeFinalRead(opp({ newsContext: news({ riskLevel: "high", timing: "now" }), historicalContext: hist() }));
  assert.equal(high.label, "AVOID_FOR_NOW");
  const med = computeFinalRead(opp({ newsContext: news({ riskLevel: "medium" }), historicalContext: hist() }));
  assert.equal(med.label, "WAIT_FOR_CONFIRMATION");
});

// ── Conflict downgrades ─────────────────────────────────────────────────────

test("history conflicting with scanner downgrades an otherwise-clean read", () => {
  const r = computeFinalRead(opp({
    newsContext: news(),
    historicalContext: hist({ alignsWithScanner: false }),
  }));
  assert.equal(r.conflict, true);
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.ok(r.reasons.some((x) => /conflict/i.test(x)));
});

// ── Weak technical badges veto regardless of clean feeds ────────────────────

test("REJECTED_BY_RISK badge => NO_TRADE even with clean feeds", () => {
  const r = computeFinalRead(opp({ statusBadge: "REJECTED_BY_RISK", newsContext: news(), historicalContext: hist() }));
  assert.equal(r.label, "NO_TRADE");
});

// ── Chart-confirmation cap ──────────────────────────────────────────────────

test("chartConfirmed !== true withholds the actionable label", () => {
  const r = computeFinalRead(opp({ chartConfirmed: false, newsContext: news(), historicalContext: hist() }));
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.ok(r.reasons.some((x) => /chart confirmation/i.test(x)));
});

// ── Closed-bar sufficiency cap (ONE DATA-SUFFICIENCY TRUTH) ─────────────────

test("LIVE feed with too few closed bars (<MIN) is never actionable — the exact scanner/Ruby contradiction", () => {
  // The feed IS live (so the step-5 data-source cap passes), but there are too
  // few closed bars to analyse. The SHARED sufficiency verdict — the same one
  // Ruby consumes — must demote the read so the scanner can't show a confident
  // setup while Ruby says "candles syncing".
  const r = computeFinalRead(opp({
    dataSource: "LIVE_FEED",
    newsContext: news(),
    historicalContext: hist(),
    sufficiency: evaluateMarketDataSufficiency({
      symbol: "EURUSD", timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 3,
    }),
  }));
  assert.notEqual(r.label, "TRADE_WATCH", "thin live data must not be actionable");
  assert.notEqual(r.confidence, "HIGH", "thin live data must not be HIGH confidence");
  assert.ok(
    r.reasons.some((x) => /candles|bars/i.test(x)),
    "names the closed-bar shortfall honestly",
  );
});

test("LIVE feed with sufficient bars + a clean verdict is NOT demoted by the sufficiency cap", () => {
  // Guard the downgrade-only contract: a sufficient verdict must not lower a
  // read that the existing caps already allow to reach the top.
  const r = computeFinalRead(opp({
    dataSource: "LIVE_FEED",
    newsContext: news(),
    historicalContext: hist(),
    sufficiency: evaluateMarketDataSufficiency({
      symbol: "EURUSD", timeframe: "M5", freshnessVerdict: "LIVE", availableClosedCandles: 50,
    }),
  }));
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "HIGH");
});

test("non-live feed with too few closed bars surfaces the SAME shared insufficiency reason (not just freshness copy)", () => {
  // LIVE_DELAYED already floors actionability via the step-5 freshness cap, but
  // the shared sufficiency verdict must STILL be the reason shown so scanner +
  // Ruby agree on WHY for the same symbol/timeframe (the 'one reason' contract).
  // The cap is downgrade-only, so on an already-floored non-live row it only
  // unifies the reason copy.
  const r = computeFinalRead(opp({
    dataSource: "LIVE_DELAYED",
    newsContext: news(),
    historicalContext: hist(),
    sufficiency: evaluateMarketDataSufficiency({
      symbol: "EURUSD", timeframe: "M5", freshnessVerdict: "LIVE_DELAYED", availableClosedCandles: 3,
    }),
  }));
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.notEqual(r.confidence, "HIGH");
  assert.ok(
    r.reasons.some((x) => /candles|bars/i.test(x)),
    "shared insufficiency reason present even on a non-live feed",
  );
});

// ── Caps are monotonic (only ever lower) ────────────────────────────────────

const CONF_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

test("every degradation keeps confidence <= the fully-confirmed baseline", () => {
  const baseline = computeFinalRead(opp({ newsContext: news(), historicalContext: hist() }));
  const degraded: ScannerOpportunity[] = [
    opp({ dataSource: "SIMULATOR", newsContext: news(), historicalContext: hist() }),
    opp({ dataSource: "AWAITING_FEED", newsContext: news(), historicalContext: hist() }),
    opp({ dataSource: "LIVE_DELAYED", newsContext: news(), historicalContext: hist() }),
    opp({ chartConfirmed: false, newsContext: news(), historicalContext: hist() }),
    opp(), // no feeds
    opp({ newsContext: news({ riskLevel: "medium" }), historicalContext: hist() }),
  ];
  for (const d of degraded) {
    const r = computeFinalRead(d);
    assert.ok(
      CONF_RANK[r.confidence] <= CONF_RANK[baseline.confidence],
      `degraded confidence ${r.confidence} must be <= baseline ${baseline.confidence}`,
    );
  }
});
