// Task #649 — Trendline Truth as a Scanner CHILD INPUT (decision-point lock).
//
// trendlineTruth.test.ts locks the CONTRACT (the verdict's scannerTruthImpact is
// downgrade-only and exposes no execution/readiness field). THIS suite locks the
// CONSUMER: computeFinalRead in marketScanner.ts must apply that impact
// downgrade-only — a trendline can SOFTEN an actionable read but can NEVER
// promote a non-actionable read to TRADE_WATCH, raise confidence, or override a
// non-live / unconfirmed feed cap. Pure & deterministic — no DB, no network.
//
// Run: node --import tsx --test src/lib/__qa__/trendlineScannerChildInput.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:trendline-scanner-child`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalRead,
  type ScannerOpportunity,
  type ScannerNewsContext,
  type ScannerHistoricalContext,
} from "../marketScanner.js";
import type { TrendlineScannerImpact } from "@workspace/domain/market";

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
    signalStrength: 88, // dual-emit alias — always equals confidenceScore
    confidenceScore: 88,
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
  return { riskLevel: "none", timing: "none", alignsWithScanner: null, ...over } as ScannerNewsContext;
}

function hist(over: Partial<ScannerHistoricalContext> = {}): ScannerHistoricalContext {
  return {
    available: true, bias: "BULLISH", confidence: "HIGH", sampleSize: 40,
    winRate: 64, avgMovePct: 1.2, worstDrawdownPct: 0.6, alignsWithScanner: true, note: "",
    ...over,
  };
}

function impact(over: Partial<TrendlineScannerImpact> = {}): TrendlineScannerImpact {
  return {
    labelHint: "none",
    confidenceCeiling: 100,
    qualityCeiling: "high",
    conditional: false,
    contextOnly: false,
    edgeAdjustment: 0,
    supportive: false,
    ...over,
  };
}

const READABLE = { newsContext: news(), historicalContext: hist() } as const;

// ── Baseline (no trendline) reaches the top, proving the fixture isn't pre-capped ─
test("baseline: live + clean + no trendline => TRADE_WATCH / HIGH", () => {
  const r = computeFinalRead(opp({ ...READABLE }));
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "HIGH");
});

// ── A supportive confirmed trendline NEVER promotes; it only colours the score ─
test("supportive confirmed trendline does NOT raise the label or confidence", () => {
  const r = computeFinalRead(
    opp({ ...READABLE, trendlineImpact: impact({ labelHint: "supportive", supportive: true, edgeAdjustment: 10 }) }),
  );
  // Identical to baseline — a supportive trendline adds no label/confidence change.
  assert.equal(r.label, "TRADE_WATCH");
  assert.equal(r.confidence, "HIGH");
  // And it injects no actionable/ready wording.
  const copy = r.reasons.join(" ");
  assert.doesNotMatch(copy, /ready now|valid now|enter now|place the trade/i);
});

// ── The CORE invariant: a trendline can never UPGRADE a non-actionable read ──
test("CORE: no labelHint can promote a non-live (non-actionable) read to TRADE_WATCH", () => {
  // Non-live feed already floors the read below TRADE_WATCH. Try EVERY labelHint
  // (including the favourable 'supportive' shape) — none may lift it.
  const hints: TrendlineScannerImpact["labelHint"][] = [
    "none", "forming_line", "needs_confirmation", "break_unconfirmed",
    "retest_watch", "mixed_conditional", "limited_room", "too_late_chase",
    "trap_risk", "trend_changed", "context_only", "supportive",
  ];
  for (const ds of ["AWAITING_FEED", "HISTORY_READY_AWAITING_LIVE_TICK", "LIVE_DELAYED", "SIMULATOR"] as const) {
    for (const labelHint of hints) {
      const r = computeFinalRead(
        opp({
          ...READABLE,
          dataSource: ds,
          trendlineImpact: impact({
            labelHint,
            supportive: labelHint === "supportive",
            contextOnly: labelHint === "context_only",
            edgeAdjustment: 10,
          }),
        }),
      );
      assert.notEqual(r.label, "TRADE_WATCH", `${ds}+${labelHint} must stay non-actionable`);
      assert.notEqual(r.confidence, "HIGH", `${ds}+${labelHint} must not be HIGH`);
    }
  }
});

// ── Unconfirmed chart: a supportive trendline cannot rescue it to actionable ──
test("CORE: supportive trendline cannot override an unconfirmed-chart withholding", () => {
  const r = computeFinalRead(
    opp({
      ...READABLE,
      chartConfirmed: false,
      trendlineImpact: impact({ labelHint: "supportive", supportive: true, edgeAdjustment: 10 }),
    }),
  );
  assert.notEqual(r.label, "TRADE_WATCH", "unconfirmed chart stays withheld despite a supportive trendline");
});

// ── Downgrade-only proof: each labelHint SOFTENS an actionable baseline ──────
test("forming/needs-confirmation/break/retest downgrades an actionable read to WAIT_FOR_CONFIRMATION", () => {
  for (const labelHint of [
    "forming_line", "needs_confirmation", "break_unconfirmed", "retest_watch", "mixed_conditional",
  ] as const) {
    const r = computeFinalRead(opp({ ...READABLE, trendlineImpact: impact({ labelHint }) }));
    assert.equal(r.label, "WAIT_FOR_CONFIRMATION", `${labelHint} softens the label`);
  }
});

test("trap_risk downgrades an actionable read to AVOID_FOR_NOW + LOW", () => {
  const r = computeFinalRead(opp({ ...READABLE, trendlineImpact: impact({ labelHint: "trap_risk" }) }));
  assert.equal(r.label, "AVOID_FOR_NOW");
  assert.equal(r.confidence, "LOW");
});

test("contextOnly trendline downgrades to WAIT_FOR_CONFIRMATION and says feed isn't live-confirmed", () => {
  const r = computeFinalRead(
    opp({ ...READABLE, trendlineImpact: impact({ labelHint: "context_only", contextOnly: true }) }),
  );
  assert.equal(r.label, "WAIT_FOR_CONFIRMATION");
  assert.ok(r.reasons.some((x) => /context only/i.test(x)));
});

test("trend_changed softens an actionable read and warns about the structure shift", () => {
  const r = computeFinalRead(opp({ ...READABLE, trendlineImpact: impact({ labelHint: "trend_changed" }) }));
  assert.equal(r.label, "WAIT_FOR_CONFIRMATION");
  assert.ok(r.reasons.some((x) => /trend shift|structure change/i.test(x)));
});

test("too_late_chase softens an actionable read and warns against chasing", () => {
  const r = computeFinalRead(opp({ ...READABLE, trendlineImpact: impact({ labelHint: "too_late_chase" }) }));
  assert.notEqual(r.label, "TRADE_WATCH");
  assert.ok(r.reasons.some((x) => /chas/i.test(x)));
});

// ── A trendline is never a SOLE gate: it cannot pull a NO_TRADE up either ────
test("a trendline cannot lift a NO_TRADE / simulator read upward", () => {
  const r = computeFinalRead(
    opp({
      ...READABLE,
      dataSource: "SIMULATOR",
      trendlineImpact: impact({ labelHint: "supportive", supportive: true, edgeAdjustment: 10 }),
    }),
  );
  // Simulator floors to LOW; a supportive trendline cannot raise it.
  assert.equal(r.confidence, "LOW");
  assert.notEqual(r.label, "TRADE_WATCH");
});
