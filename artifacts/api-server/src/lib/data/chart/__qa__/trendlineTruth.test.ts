// Task #649 — Trendline Truth Engine: OFFLINE pure fixture suite.
//
// Locks the HARD BOUNDARY: a detected trendline is a CHILD INPUT to Scanner /
// Pattern Truth. It may raise/lower display quality + confidence (within caps),
// wording, edge, chase/too-late, break/retest/reclaim/failure, channel, and
// conditional-vs-confirmed labels — but it can NEVER independently produce
// READY_NOW, override historical/unconfirmed-feed status, override
// low-confidence/trade-health/risk gates, or touch live execution.
//
// No DB, no live providers — every verdict is built deterministically from a
// fixture ActiveTrendline[] + the caller's already-decided display facts, so the
// suite runs in the offline `ci` lane. Wired as
// `pnpm --filter @workspace/api-server run test:trendline-truth`.
//
// Run: node --import tsx --test src/lib/data/chart/__qa__/trendlineTruth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrendlineTruth,
  aggregateTrendlineReliability,
  TRENDLINE_MIN_RESOLVED_FOR_SCORE,
  TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
  TRENDLINE_LIBRARY,
  TRENDLINE_LIBRARY_CATEGORIES,
  trendlineLibraryIds,
  trendlineChangeKinds,
  patternChangeKinds,
  TRENDLINE_CHANGE_CATALOG,
  PATTERN_CHANGE_CATALOG,
  type ActiveTrendline,
  type TrendlineContext,
  type TrendlineDisplayContext,
  type TrendlineChange,
  type PatternChange,
  type TrendlineOutcomeSample,
  type TrendlineCategory,
} from "@workspace/domain/market";
import { buildTrendlineTruthVerdict } from "../trendlineTruthService.js";
import { detectTrendlines } from "../engines/trendlineEngine.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function tl(over: Partial<ActiveTrendline> = {}): ActiveTrendline {
  return {
    id: "ascending_support",
    name: "Ascending Support",
    category: "trend_support",
    bias: "bullish",
    status: "confirmed",
    confidence: 90,
    quality: "high",
    touchCount: 3,
    slope: 0.01,
    currentLevel: 1.1,
    levels: { confirmation: 1.105, invalidation: 1.09, targets: [1.13] },
    keyPoints: [
      { index: 10, price: 1.09, role: "anchor" },
      { index: 20, price: 1.095, role: "touch" },
      { index: 30, price: 1.1, role: "touch" },
    ],
    rationale: ["Three rising lows", "Line respected on each touch"],
    failureModes: ["A close below the line invalidates the read"],
    minCandles: 20,
    falseBreakoutRisk: "medium",
    ...over,
  };
}

// A live-confirmed, setup-allowed, clean-read display context (the most
// permissive caller state — proves the trendline still cannot over-promote).
function disp(over: Partial<TrendlineDisplayContext> = {}): TrendlineDisplayContext {
  return {
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    ...over,
  };
}

function ctx(over: Partial<TrendlineContext> = {}): TrendlineContext {
  return {
    trend: "bullish",
    nearSupportResistance: false,
    distanceToSrAtr: null,
    momentumAligned: true,
    volatilityAtr: 0.001,
    ...over,
  };
}

function change(over: Partial<TrendlineChange> = {}): TrendlineChange {
  return {
    kind: "break",
    bias: "bullish",
    reason: "Close beyond the line by > 1 ATR.",
    confirmationLevel: 1.105,
    invalidationLevel: 1.09,
    confirmed: true,
    ...over,
  };
}

function patChange(over: Partial<PatternChange> = {}): PatternChange {
  return {
    kind: "trend_shift_bullish",
    from: "range",
    to: "uptrend",
    reason: "Resistance break plus higher lows.",
    confirmationLevel: 1.105,
    invalidationLevel: 1.09,
    ...over,
  };
}

// ── 1. Forming line is conditional + forming, never confirmed ───────────────
test("1: forming trendline is conditional + forming_line, never supportive", () => {
  const v = resolveTrendlineTruth([tl({ status: "forming" })], ctx(), disp());
  assert.equal(v.status, "forming");
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.labelHint, "forming_line");
});

// ── 2. Confirmed line never bypasses feed truth ─────────────────────────────
test("2: confirmed line on an unconfirmed feed is context-only, not supportive", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed" })],
    ctx(),
    disp({ feedConfirmed: false }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 0);
});

// ── 3. Forming line caps confidence at the forming ceiling ──────────────────
test("3: forming line caps display confidence at the forming ceiling (60)", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "forming", confidence: 95 })],
    ctx(),
    disp(),
  );
  assert.ok(v.confidence <= 60, `confidence ${v.confidence} must be <= 60`);
  assert.ok(v.scannerTruthImpact.confidenceCeiling <= 60);
});

// ── 4. Exhausted line → too-late chase ──────────────────────────────────────
test("4: exhausted line is too-late-chase with chaseRisk", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "exhausted", confidence: 80 })],
    ctx(),
    disp(),
  );
  assert.equal(v.status, "exhausted");
  assert.equal(v.chaseRisk, true);
  assert.equal(v.scannerTruthImpact.labelHint, "too_late_chase");
  assert.ok(v.confidence <= 40);
});

// ── 5. Confirmed + aligned + live → supportive (still no READY_NOW) ──────────
test("5: confirmed aligned line on a live feed is supportive (nudge only)", () => {
  const v = resolveTrendlineTruth([tl({ status: "confirmed" })], ctx(), disp());
  assert.equal(v.scannerTruthImpact.supportive, true);
  assert.equal(v.scannerTruthImpact.labelHint, "supportive");
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 10);
});

// ── 6. Failed break → trap risk (hardest cap) ───────────────────────────────
test("6: failed break is trap_risk with the trap cap + max negative edge", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "failed", confidence: 85 })],
    ctx(),
    disp(),
  );
  assert.equal(v.scannerTruthImpact.labelHint, "trap_risk");
  assert.equal(v.scannerTruthImpact.qualityCeiling, "none");
  assert.equal(v.scannerTruthImpact.edgeAdjustment, -25);
  assert.ok(v.confidence <= 25);
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 7. Target inside nearby S/R → limited-room warning + cap ─────────────────
test("7: target inside nearby S/R raises a limited-room warning + cap", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed", confidence: 80 })],
    ctx({ nearSupportResistance: true, distanceToSrAtr: 0.5 }),
    disp(),
  );
  assert.ok(v.warnings.some((w) => /limited room/i.test(w)));
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 8. Trendline on an insufficient feed → context-only ─────────────────────
test("8: trendline on a historical/insufficient feed is context-only", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed" })],
    ctx(),
    disp({ sufficiencyAllowsSetup: false }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.ok(v.confidence <= 35);
});

// ── 9. Trendline against HTF bias → capped + mixed-conditional ───────────────
test("9: trendline conflicting with HTF trend is mixed-conditional, never supportive", () => {
  const v = resolveTrendlineTruth(
    [tl({ bias: "bullish", status: "confirmed", confidence: 85 })],
    ctx({ trend: "bearish" }), // confirmed bullish line vs bearish HTF
    disp(),
  );
  assert.equal(v.scannerTruthImpact.labelHint, "mixed_conditional");
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= -10);
});

// ── 10. Target inside S/R → quality cap ─────────────────────────────────────
test("10: limited room caps display quality to at most medium", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed", quality: "high", confidence: 80 })],
    ctx({ nearSupportResistance: true, distanceToSrAtr: 1 }),
    disp(),
  );
  assert.notEqual(v.quality, "high");
});

// ── 11. Verdict feeds Scanner Truth (downgrade-only impact present) ──────────
test("11: verdict exposes a downgrade-only scannerTruthImpact for Scanner Truth", () => {
  const v = resolveTrendlineTruth([tl({ status: "forming" })], ctx(), disp());
  const i = v.scannerTruthImpact;
  assert.ok(i.confidenceCeiling <= 100);
  assert.ok(["high", "medium", "low", "none"].includes(i.qualityCeiling));
  assert.ok(i.edgeAdjustment >= -25 && i.edgeAdjustment <= 10);
});

// ── 12 & 15. Trendline can NEVER produce ready-now / execution permission ────
test("12/15: scannerTruthImpact carries NO ready-now / execution permission field", () => {
  const supportive = resolveTrendlineTruth([tl({ status: "confirmed" })], ctx(), disp());
  // Even the most favourable (confirmed + live + aligned) verdict only nudges
  // edge within bound; it exposes no readiness/execution key.
  assert.equal(supportive.scannerTruthImpact.supportive, true);
  assert.ok(supportive.scannerTruthImpact.edgeAdjustment <= 10);

  const keys = Object.keys(supportive.scannerTruthImpact).sort();
  assert.deepEqual(keys, [
    "conditional",
    "confidenceCeiling",
    "contextOnly",
    "edgeAdjustment",
    "labelHint",
    "qualityCeiling",
    "supportive",
  ]);
  for (const k of keys) {
    assert.doesNotMatch(k, /ready|execut|broker|kill|order|dispatch|live/i, `key ${k} must not imply execution`);
  }
});

// ── 13. Unconfirmed break stays conditional (no clean confirmation) ──────────
test("13: an unconfirmed (wick-only) break is break_unconfirmed + capped, never supportive", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "broken", confidence: 80 })],
    ctx(),
    disp(),
    change({ confirmed: false }),
  );
  assert.equal(v.scannerTruthImpact.labelHint, "break_unconfirmed");
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.ok(v.confidence <= 50);
});

// ── 14. Ruby explanation narrates confirmation + invalidation levels ────────
test("14: ruby explanation narrates the confirmation and invalidation levels", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "forming", levels: { confirmation: 1.105, invalidation: 1.12, targets: [1.08] } })],
    ctx(),
    disp(),
  );
  assert.match(v.rubyExplanation, /1\.105/);
  assert.match(v.rubyExplanation, /1\.12/);
  assert.match(v.rubyExplanation, /forming/i);
});

// ── 16. A printed pattern change forces trend_changed + conditional ─────────
test("16: a confirmed trendline + a pattern change downgrades to trend_changed", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed", confidence: 85 })],
    ctx(),
    disp(),
    change({ kind: "none", confirmed: false, reason: null, confirmationLevel: null, invalidationLevel: null }),
    patChange(),
  );
  assert.equal(v.scannerTruthImpact.labelHint, "trend_changed");
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 16b. No dominant line + a pattern change still flags trend_changed ───────
test("16b: empty trendlines + a pattern change reports trend_changed (no dominant)", () => {
  const v = resolveTrendlineTruth([], ctx(), disp(), undefined, patChange());
  assert.equal(v.dominantTrendline, null);
  assert.equal(v.scannerTruthImpact.labelHint, "trend_changed");
  assert.equal(v.scannerTruthImpact.supportive, false);

  // No trendlines AND no pattern change → a clean, neutral, non-downgrading read.
  const none = resolveTrendlineTruth([], ctx(), disp());
  assert.equal(none.dominantTrendline, null);
  assert.equal(none.scannerTruthImpact.labelHint, "none");
  assert.equal(none.scannerTruthImpact.conditional, false);
});

// ── 17. Detector fails closed on insufficient candles ───────────────────────
test("17: detector returns insufficient + no trendlines on a too-short window", () => {
  const short = Array.from({ length: 5 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 1 + i * 0.001,
    high: 1 + i * 0.001 + 0.0005,
    low: 1 + i * 0.001 - 0.0005,
    close: 1 + i * 0.001,
    isComplete: true,
    isForming: false,
  }));
  const r = detectTrendlines(short as never);
  assert.equal(r.insufficient, true);
  assert.equal(r.trendlines.length, 0);
});

// ── 18. Service returns null on an unsupported timeframe / empty candles ─────
test("18: buildTrendlineTruthVerdict returns null on an unsupported timeframe / empty candles", () => {
  const badTf = buildTrendlineTruthVerdict({
    symbol: "EURUSD",
    timeframe: "not-a-timeframe",
    rawCandles: [{ time: 1, open: 1, high: 1, low: 1, close: 1 } as never],
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    trend: "neutral",
    momentumAligned: false,
    nearSupportResistance: false,
    distanceToSrAtr: null,
    volatilityAtr: null,
  });
  assert.equal(badTf, null);

  const noCandles = buildTrendlineTruthVerdict({
    symbol: "EURUSD",
    timeframe: "1h",
    rawCandles: [],
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    trend: "neutral",
    momentumAligned: false,
    nearSupportResistance: false,
    distanceToSrAtr: null,
    volatilityAtr: null,
  });
  assert.equal(noCandles, null);
});

// ── 19. Synthetic stats tracked separately from forex/indices ───────────────
test("19: reliability aggregation separates synthetic from forex/indices", () => {
  const samples: TrendlineOutcomeSample[] = [];
  // 6 forex WINS (high reliability).
  for (let i = 0; i < 6; i++) {
    samples.push({
      symbol: "EURUSD",
      timeframe: "1h",
      session: "london",
      isSynthetic: false,
      trendlineId: "ascending_support",
      bias: "bullish",
      outcome: "WIN",
      realizedR: 2,
      mfeR: 2.5,
      maeR: -0.5,
    });
  }
  // 6 synthetic LOSSES (low reliability).
  for (let i = 0; i < 6; i++) {
    samples.push({
      symbol: "Volatility 75 Index",
      timeframe: "1h",
      session: "newyork",
      isSynthetic: true,
      trendlineId: "ascending_support",
      bias: "bullish",
      outcome: "LOSS",
      realizedR: -1,
      mfeR: 0.2,
      maeR: -1.2,
    });
  }
  const { forexIndices, synthetic } = aggregateTrendlineReliability(samples);
  assert.equal(forexIndices.resolvedCount, 6);
  assert.equal(synthetic.resolvedCount, 6);
  assert.notEqual(forexIndices.reliabilityScore, null);
  assert.notEqual(synthetic.reliabilityScore, null);
  assert.ok(
    (forexIndices.reliabilityScore ?? 0) > (synthetic.reliabilityScore ?? 100),
    "all-win forex must outscore all-loss synthetic",
  );
  // Adjustments stay bounded by the hard cap.
  assert.ok(Math.abs(forexIndices.rubyConfidenceAdjustment) <= TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT);
  assert.ok(Math.abs(synthetic.rubyConfidenceAdjustment) <= TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT);
});

test("19b: reliability score withheld until TRENDLINE_MIN_RESOLVED_FOR_SCORE resolved samples", () => {
  const few: TrendlineOutcomeSample[] = Array.from(
    { length: TRENDLINE_MIN_RESOLVED_FOR_SCORE - 1 },
    () => ({
      symbol: "EURUSD",
      timeframe: "1h",
      session: "london",
      isSynthetic: false,
      trendlineId: "descending_resistance",
      bias: "bearish",
      outcome: "WIN" as const,
      realizedR: 1,
      mfeR: 1,
      maeR: 0,
    }),
  );
  const { forexIndices } = aggregateTrendlineReliability(few);
  assert.equal(forexIndices.reliabilityScore, null);
  assert.equal(forexIndices.rubyConfidenceAdjustment, 0);
});

// ── 20. Stale feed forces context-only wording (no live-ready phrasing) ──────
test("20: stale feed forces context-only wording (no live-ready phrasing)", () => {
  const v = resolveTrendlineTruth(
    [tl({ status: "confirmed", confidence: 85 })],
    ctx(),
    disp({ feedStale: true }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 0);
  assert.match(v.rubyExplanation, /context only/i);
  assert.doesNotMatch(v.rubyExplanation, /ready now|valid now/i);
});

// ── Library cross-check ─────────────────────────────────────────────────────
// The typed in-repo inventory is the SPEC the detector implements against. Lock
// that it is internally consistent and that every TrendlineCategory family has
// at least one catalogued entry.
test("library: every TrendlineCategory family has at least one catalogued entry", () => {
  const categories: TrendlineCategory[] = [
    "trend_support",
    "trend_resistance",
    "channel",
    "horizontal",
  ];
  assert.deepEqual([...TRENDLINE_LIBRARY_CATEGORIES].sort(), [...categories].sort());
  for (const cat of categories) {
    const entries = TRENDLINE_LIBRARY.filter((e) => e.category === cat);
    assert.ok(entries.length >= 1, `category ${cat} must have >= 1 library entry`);
  }
});

test("library: entries are well-formed and ids are unique", () => {
  const ids = TRENDLINE_LIBRARY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "library ids must be unique");
  for (const e of TRENDLINE_LIBRARY) {
    assert.ok(e.id.length > 0 && e.name.length > 0, `entry ${e.id} needs id + name`);
    assert.ok(e.minCandles > 0, `entry ${e.id} needs a positive minCandles`);
    assert.ok(e.minTouches >= 2, `entry ${e.id} needs >= 2 defining touches`);
    assert.ok(e.detection.length > 0, `entry ${e.id} needs detection criteria`);
    assert.ok(e.confirmation.length > 0, `entry ${e.id} needs a confirmation rule`);
    assert.ok(e.invalidation.length > 0, `entry ${e.id} needs an invalidation rule`);
    assert.ok(e.failureModes.length > 0, `entry ${e.id} needs honest failure modes`);
    assert.ok(["bullish", "bearish", "neutral", "both"].includes(e.bias));
    assert.ok(["low", "medium", "high"].includes(e.falseBreakoutRisk));
  }
  // trendlineLibraryIds() is the lookup the detector cross-check relies on.
  assert.deepEqual([...trendlineLibraryIds()].sort(), [...ids].sort());
});

test("library: change + pattern-change catalogs are well-formed and unique", () => {
  const tcKinds = [...trendlineChangeKinds()];
  assert.equal(tcKinds.length, TRENDLINE_CHANGE_CATALOG.length, "change kinds unique");
  assert.ok(tcKinds.includes("none") && tcKinds.includes("break") && tcKinds.includes("failure"));

  const pcKinds = [...patternChangeKinds()];
  assert.equal(pcKinds.length, PATTERN_CHANGE_CATALOG.length, "pattern-change kinds unique");
  assert.ok(
    pcKinds.includes("trend_shift_bullish") && pcKinds.includes("trend_shift_bearish"),
    "trend-shift transitions must be catalogued",
  );
});
