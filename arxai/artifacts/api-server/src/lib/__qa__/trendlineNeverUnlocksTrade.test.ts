// Task #650 — ADVERSARIAL SAFETY GUARD: a trendline can NEVER unlock a trade.
//
// trendlineScannerChildInput.test.ts proves the normal downgrade behaviour of a
// handful of representative trendline verdicts. THIS suite is the dedicated
// adversarial guard the architect review asked to lock in: it asserts that NO
// trendline impact value — across the FULL matrix of labelHint × confidence
// ceiling × quality ceiling × supportive/contextOnly/conditional × edge
// adjustment, AND the most favourable realistic verdicts (strong confirmation,
// bullish reclaim, channel breakout) produced by the real resolveTrendlineTruth
// contract — can ever PROMOTE a non-actionable base read into an actionable one.
//
// The invariant proven, for EVERY base scenario and EVERY trendline value:
//   1. the final label is never raised above its pre-trendline value, and is
//      never TRADE_WATCH (the "ready / unlock" actionable state),
//   2. the final confidence is never raised above its pre-trendline ceiling,
//   3. no trendline ever injects "ready now / valid now / enter now" wording,
//   4. the TrendlineScannerImpact surface carries NO execution-permission field.
//
// Pure & deterministic — no DB, no network, no clock.
//
// Run: node --import tsx --test src/lib/__qa__/trendlineNeverUnlocksTrade.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:trendline-never-unlocks`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFinalRead,
  type ScannerOpportunity,
  type ScannerFinalRead,
  type ScannerNewsContext,
  type ScannerHistoricalContext,
} from "../marketScanner.js";
import {
  resolveTrendlineTruth,
  type TrendlineScannerImpact,
  type TrendlineScannerLabelHint,
  type TrendlineQuality,
  type ActiveTrendline,
  type TrendlineContext,
  type TrendlineDisplayContext,
  type TrendlineChange,
} from "@workspace/domain/market";

// ── Fixtures (mirror trendlineScannerChildInput.test.ts) ────────────────────
function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
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

const READABLE = { newsContext: news(), historicalContext: hist() } as const;

// ── Rank helpers: higher = more actionable / more confident ─────────────────
const LABEL_RANK: Record<ScannerFinalRead["label"], number> = {
  NO_TRADE: 0,
  AVOID_FOR_NOW: 1,
  WAIT_FOR_CONFIRMATION: 2,
  TRADE_WATCH: 3,
};
const CONF_RANK: Record<ScannerFinalRead["confidence"], number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

const READY_WORDING = /ready now|valid now|enter now|place the trade|go long now|go short now/i;

// ── Non-actionable base reads (each reaches the pipeline a DIFFERENT way) ────
// Every base must be non-actionable WITHOUT any trendline. The matrix below then
// proves no trendline value can lift ANY of them.
const NON_ACTIONABLE_BASES: { name: string; over: Partial<ScannerOpportunity> }[] = [
  { name: "AWAITING_FEED (no live tick)", over: { ...READABLE, dataSource: "AWAITING_FEED" } },
  { name: "HISTORY_READY_AWAITING_LIVE_TICK (warming up)", over: { ...READABLE, dataSource: "HISTORY_READY_AWAITING_LIVE_TICK" } },
  { name: "LIVE_DELAYED (delayed candle)", over: { ...READABLE, dataSource: "LIVE_DELAYED" } },
  { name: "STALE_FEED (lagging feed)", over: { ...READABLE, dataSource: "STALE_FEED" } },
  { name: "SIMULATOR (synthetic data)", over: { ...READABLE, dataSource: "SIMULATOR" } },
  { name: "unconfirmed chart on a live feed", over: { ...READABLE, chartConfirmed: false } },
  { name: "LOW_CONFIDENCE technical badge", over: { ...READABLE, statusBadge: "LOW_CONFIDENCE" } },
  { name: "REJECTED_BY_RISK badge", over: { ...READABLE, statusBadge: "REJECTED_BY_RISK" } },
  { name: "CHOPPY_MARKET badge", over: { ...READABLE, statusBadge: "CHOPPY_MARKET" } },
  { name: "critical news window", over: { ...READABLE, newsContext: news({ riskLevel: "critical", timing: "now" }) } },
  { name: "high news now", over: { ...READABLE, newsContext: news({ riskLevel: "high", timing: "now" }) } },
  { name: "technical/history conflict", over: { ...READABLE, historicalContext: hist({ alignsWithScanner: false }) } },
  {
    name: "insufficiency withholds confidence",
    over: {
      ...READABLE,
      sufficiency: {
        mayShowConfidence: false,
        humanReason: "Not enough closed candles to confirm a setup yet.",
      } as unknown as ScannerOpportunity["sufficiency"],
    },
  },
];

// ── The full synthetic impact matrix ────────────────────────────────────────
const ALL_HINTS: TrendlineScannerLabelHint[] = [
  "none", "context_only", "forming_line", "needs_confirmation", "break_unconfirmed",
  "retest_watch", "trap_risk", "too_late_chase", "trend_changed", "mixed_conditional",
  "limited_room", "supportive",
];
const CONF_CEILINGS = [0, 25, 50, 60, 100];
const QUALITY_CEILINGS: TrendlineQuality[] = ["none", "low", "medium", "high"];
const EDGE_ADJUSTMENTS = [-25, 0, 10];

function* impactMatrix(): Generator<TrendlineScannerImpact> {
  for (const labelHint of ALL_HINTS) {
    for (const confidenceCeiling of CONF_CEILINGS) {
      for (const qualityCeiling of QUALITY_CEILINGS) {
        for (const supportive of [true, false]) {
          for (const contextOnly of [true, false]) {
            for (const conditional of [true, false]) {
              for (const edgeAdjustment of EDGE_ADJUSTMENTS) {
                yield {
                  labelHint, confidenceCeiling, qualityCeiling,
                  conditional, contextOnly, edgeAdjustment, supportive,
                };
              }
            }
          }
        }
      }
    }
  }
}

// ── CORE: the full synthetic matrix can never promote ANY base read ──────────
test("ADVERSARIAL: no synthetic trendline impact can promote a non-actionable read", () => {
  let combos = 0;
  for (const base of NON_ACTIONABLE_BASES) {
    // Baseline WITHOUT any trendline — the ceiling every trendline must respect.
    const baseline = computeFinalRead(opp(base.over));
    assert.notEqual(
      baseline.label,
      "TRADE_WATCH",
      `fixture error: base "${base.name}" must be non-actionable before any trendline`,
    );

    for (const trendlineImpact of impactMatrix()) {
      combos++;
      const r = computeFinalRead(opp({ ...base.over, trendlineImpact }));

      // (1) never raised above the pre-trendline label, never the actionable one.
      assert.ok(
        LABEL_RANK[r.label] <= LABEL_RANK[baseline.label],
        `${base.name} + ${JSON.stringify(trendlineImpact)} raised label ${baseline.label} → ${r.label}`,
      );
      assert.notEqual(
        r.label,
        "TRADE_WATCH",
        `${base.name} + ${JSON.stringify(trendlineImpact)} unlocked TRADE_WATCH`,
      );

      // (2) confidence never exceeds the pre-trendline ceiling.
      assert.ok(
        CONF_RANK[r.confidence] <= CONF_RANK[baseline.confidence],
        `${base.name} + ${JSON.stringify(trendlineImpact)} raised confidence ${baseline.confidence} → ${r.confidence}`,
      );

      // (3) no "ready/unlock" wording ever leaks in.
      assert.doesNotMatch(
        r.reasons.join(" "),
        READY_WORDING,
        `${base.name} + ${JSON.stringify(trendlineImpact)} injected ready-now wording`,
      );
    }
  }
  // The matrix actually exercised a non-trivial number of combinations.
  assert.ok(combos > 5000, `expected a large adversarial matrix, ran ${combos}`);
});

// ── Realistic verdicts from the REAL contract (the favourable shapes) ────────
function line(over: Partial<ActiveTrendline> = {}): ActiveTrendline {
  return {
    id: "ascending_support",
    name: "Ascending Support",
    category: "trend_support",
    bias: "bullish",
    status: "confirmed",
    confidence: 96,
    quality: "high",
    touchCount: 5,
    slope: 0.001,
    currentLevel: 1.095,
    levels: { confirmation: 1.1, invalidation: 1.08, targets: [1.13, 1.15] },
    keyPoints: [],
    rationale: ["5 clean touches"],
    failureModes: [],
    minCandles: 20,
    falseBreakoutRisk: "low",
    ...over,
  };
}

// The MOST favourable display facts a trendline could ever see — exactly the
// conditions under which resolveTrendlineTruth is allowed its supportive nudge.
const FAVORABLE_CONTEXT: TrendlineContext = {
  trend: "bullish",
  nearSupportResistance: false,
  distanceToSrAtr: 8,
  momentumAligned: true,
  volatilityAtr: 0.001,
};
const FAVORABLE_DISPLAY: TrendlineDisplayContext = {
  feedConfirmed: true,
  feedStale: false,
  sufficiencyAllowsSetup: true,
  chartReadConfidenceLow: false,
};
const CONFIRMED_CHANGE: TrendlineChange = {
  kind: "break",
  bias: "bullish",
  reason: "Resistance broke with a decisive close beyond + ATR distance.",
  confirmationLevel: 1.1,
  invalidationLevel: 1.08,
  confirmed: true,
};

// Each is the strongest plausible "bullish" verdict — these are the ones that
// could conceivably tempt the pipeline into unlocking. The contract MUST keep
// every one downgrade-only.
const FAVORABLE_VERDICTS: { name: string; impact: TrendlineScannerImpact }[] = [
  {
    name: "strong confirmation (confirmed + aligned + live)",
    impact: resolveTrendlineTruth([line({ status: "confirmed" })], FAVORABLE_CONTEXT, FAVORABLE_DISPLAY)
      .scannerTruthImpact,
  },
  {
    name: "bullish reclaim",
    impact: resolveTrendlineTruth([line({ status: "reclaimed" })], FAVORABLE_CONTEXT, FAVORABLE_DISPLAY)
      .scannerTruthImpact,
  },
  {
    name: "channel breakout (confirmed break)",
    impact: resolveTrendlineTruth(
      [line({ id: "ascending_channel", name: "Ascending Channel", category: "channel", status: "broken" })],
      FAVORABLE_CONTEXT,
      FAVORABLE_DISPLAY,
      CONFIRMED_CHANGE,
    ).scannerTruthImpact,
  },
];

test("ADVERSARIAL: the strongest realistic verdicts still never promote a non-actionable read", () => {
  for (const base of NON_ACTIONABLE_BASES) {
    const baseline = computeFinalRead(opp(base.over));
    for (const v of FAVORABLE_VERDICTS) {
      const r = computeFinalRead(opp({ ...base.over, trendlineImpact: v.impact }));
      assert.ok(
        LABEL_RANK[r.label] <= LABEL_RANK[baseline.label],
        `${base.name} + ${v.name} raised label ${baseline.label} → ${r.label}`,
      );
      assert.notEqual(r.label, "TRADE_WATCH", `${base.name} + ${v.name} unlocked TRADE_WATCH`);
      assert.ok(
        CONF_RANK[r.confidence] <= CONF_RANK[baseline.confidence],
        `${base.name} + ${v.name} raised confidence ${baseline.confidence} → ${r.confidence}`,
      );
      assert.doesNotMatch(r.reasons.join(" "), READY_WORDING, `${base.name} + ${v.name} injected ready-now wording`);
    }
  }
});

// ── A favourable verdict cannot even lift an ACTIONABLE baseline above itself ─
// (supportive is purely additive to the upstream edge score, never the label.)
test("ADVERSARIAL: a supportive verdict never raises an already-actionable read above TRADE_WATCH/HIGH", () => {
  const actionableBaseline = computeFinalRead(opp({ ...READABLE }));
  assert.equal(actionableBaseline.label, "TRADE_WATCH");
  assert.equal(actionableBaseline.confidence, "HIGH");
  for (const v of FAVORABLE_VERDICTS) {
    const r = computeFinalRead(opp({ ...READABLE, trendlineImpact: v.impact }));
    // TRADE_WATCH / HIGH are already the ceiling — a trendline must not exceed it
    // (there is nothing higher to exceed; this asserts it does not invent one).
    assert.ok(LABEL_RANK[r.label] <= LABEL_RANK["TRADE_WATCH"]);
    assert.ok(CONF_RANK[r.confidence] <= CONF_RANK["HIGH"]);
  }
});

// ── Structural: the impact surface exposes NO execution-permission field ─────
test("ADVERSARIAL: TrendlineScannerImpact carries no execution/permission field", () => {
  const forbidden = /execut|ready_?now|unlock|permit|dispatch|broker|kill.?switch|grant|order.?send|allow.?(order|trade|execution)/i;
  for (const v of FAVORABLE_VERDICTS) {
    for (const key of Object.keys(v.impact)) {
      assert.doesNotMatch(key, forbidden, `impact exposes a suspicious key: ${key}`);
    }
  }
  // The supportive nudge is bounded to a small, non-execution edge value.
  for (const v of FAVORABLE_VERDICTS) {
    assert.ok(v.impact.edgeAdjustment <= 10, `edgeAdjustment must stay bounded (≤ +10), got ${v.impact.edgeAdjustment}`);
  }
});
