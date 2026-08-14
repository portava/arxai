// Task #617 — Chart Pattern Truth Engine: OFFLINE pure fixture suite.
//
// Locks the HARD BOUNDARY: a detected pattern is a CHILD INPUT to Scanner Truth.
// It may raise/lower display quality + confidence (within caps), wording, edge,
// chase/too-late, and conditional-vs-confirmed labels — but it can NEVER
// independently produce READY_NOW, override historical/unconfirmed-feed status,
// override low-confidence/trade-health/risk gates, or touch live execution.
//
// No DB, no live providers — every verdict is built deterministically from a
// fixture DetectedPattern[] + the caller's already-decided display facts, so the
// suite runs in the offline `ci` lane. Wired as
// `pnpm --filter @workspace/api-server run test:pattern-truth`.
//
// Run: node --import tsx --test src/lib/data/chart/__qa__/patternTruth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePatternTruth,
  aggregatePatternReliability,
  MIN_RESOLVED_FOR_SCORE,
  MAX_CONFIDENCE_ADJUSTMENT,
  PATTERN_LIBRARY,
  PATTERN_LIBRARY_CATEGORIES,
  patternLibraryIds,
  evaluateMarketDataSufficiency,
  type DetectedPattern,
  type PatternContext,
  type PatternDisplayContext,
  type PatternOutcomeSample,
  type PatternCategory,
} from "@workspace/domain/market";
import { buildPatternTruthVerdict } from "../patternTruthService.js";
import { detectChartPatterns } from "../engines/patternEngine.js";
import { evaluateScalp } from "../../../scalp/scalpEngine.js";
import type {
  ScalpEngineInput,
  ScalpSpecInput,
  ScalpScannerInput,
} from "../../../scalp/scalpTypes.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function pat(over: Partial<DetectedPattern> = {}): DetectedPattern {
  return {
    id: "head_and_shoulders",
    name: "Head & Shoulders",
    category: "reversal",
    bias: "bearish",
    status: "forming",
    confidence: 90,
    quality: "high",
    levels: { confirmation: 1.105, invalidation: 1.12, targets: [1.08] },
    keyPoints: [],
    rationale: ["Symmetric shoulders", "Neckline located"],
    failureModes: ["Neckline break can fail and snap back"],
    minCandles: 30,
    entryTiming: "clean",
    falseBreakoutRisk: "medium",
    ...over,
  };
}

// A live-confirmed, setup-allowed, clean-trend display context (the most
// permissive caller state — proves the pattern still cannot over-promote).
function disp(over: Partial<PatternDisplayContext> = {}): PatternDisplayContext {
  return {
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    ...over,
  };
}

function ctx(over: Partial<PatternContext> = {}): PatternContext {
  return {
    trend: "bearish",
    nearSupportResistance: false,
    distanceToSrAtr: null,
    momentumAligned: true,
    volatilityAtr: 0.001,
    ...over,
  };
}

// ── 1. Forming H&S, not confirmed pre-neckline ──────────────────────────────
test("1: forming H&S is conditional + needs confirmation, never confirmed", () => {
  const v = resolvePatternTruth([pat({ status: "forming" })], ctx(), disp());
  assert.equal(v.status, "forming");
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.labelHint, "needs_confirmation");
});

// ── 2. Confirmed H&S never bypasses feed truth ──────────────────────────────
test("2: confirmed H&S on an unconfirmed feed is context-only, not supportive", () => {
  const v = resolvePatternTruth(
    [pat({ status: "confirmed" })],
    ctx(),
    disp({ feedConfirmed: false }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 0);
});

// ── 3. Bull flag forming caps confidence ────────────────────────────────────
test("3: forming bull flag caps display confidence at the forming ceiling", () => {
  const v = resolvePatternTruth(
    [pat({ id: "bull_flag", name: "Bull Flag", category: "continuation", bias: "bullish", status: "forming", confidence: 95 })],
    ctx({ trend: "bullish" }),
    disp(),
  );
  // Raw 95 → capped to the forming ceiling (60).
  assert.ok(v.confidence <= 60, `confidence ${v.confidence} must be <= 60`);
  assert.ok(v.scannerTruthImpact.confidenceCeiling <= 60);
});

// ── 4. Bull flag exhausted → too-late chase ─────────────────────────────────
test("4: exhausted bull flag is too-late-chase with chaseRisk", () => {
  const v = resolvePatternTruth(
    [pat({ id: "bull_flag", name: "Bull Flag", bias: "bullish", status: "exhausted", confidence: 80 })],
    ctx({ trend: "bullish" }),
    disp(),
  );
  assert.equal(v.status, "exhausted");
  assert.equal(v.chaseRisk, true);
  assert.equal(v.scannerTruthImpact.labelHint, "too_late_chase");
  assert.ok(v.confidence <= 40);
});

// ── 5. Double bottom needs neckline break ───────────────────────────────────
test("5: forming double bottom stays conditional until confirmed", () => {
  const forming = resolvePatternTruth(
    [pat({ id: "double_bottom", name: "Double Bottom", category: "reversal", bias: "bullish", status: "forming", confidence: 70 })],
    ctx({ trend: "bullish" }),
    disp(),
  );
  assert.equal(forming.scannerTruthImpact.conditional, true);
  assert.equal(forming.scannerTruthImpact.supportive, false);

  const confirmed = resolvePatternTruth(
    [pat({ id: "double_bottom", name: "Double Bottom", category: "reversal", bias: "bullish", status: "confirmed", confidence: 70 })],
    ctx({ trend: "bullish" }),
    disp(),
  );
  assert.equal(confirmed.scannerTruthImpact.supportive, true);
});

// ── 6. Liquidity sweep needs reclaim/rejection ──────────────────────────────
test("6: forming liquidity sweep is not supportive until it reclaims (confirmed)", () => {
  const v = resolvePatternTruth(
    [pat({ id: "liquidity_sweep", name: "Liquidity Sweep", category: "structure", bias: "bullish", status: "forming", confidence: 75 })],
    ctx({ trend: "bullish" }),
    disp(),
  );
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.conditional, true);
});

// ── 7. Bear flag near major support → limited-room warning ───────────────────
test("7: pattern target inside nearby S/R raises a limited-room warning + cap", () => {
  const v = resolvePatternTruth(
    [pat({ id: "bear_flag", name: "Bear Flag", category: "continuation", bias: "bearish", status: "confirmed", confidence: 80 })],
    ctx({ trend: "bearish", nearSupportResistance: true, distanceToSrAtr: 0.5 }),
    disp(),
  );
  assert.equal(v.rrContext.limitedRoom, true);
  assert.ok(v.warnings.some((w) => /limited room/i.test(w)));
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 8. Pattern on historical-only feed → context-only ───────────────────────
test("8: pattern on a historical/insufficient feed is context-only", () => {
  const v = resolvePatternTruth(
    [pat({ status: "confirmed" })],
    ctx(),
    disp({ sufficiencyAllowsSetup: false }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.ok(v.confidence <= 35);
});

// ── 9. Pattern against HTF bias → capped + mixed-conditional ─────────────────
test("9: pattern conflicting with HTF trend is mixed-conditional, never supportive", () => {
  const v = resolvePatternTruth(
    [pat({ bias: "bullish", status: "confirmed", confidence: 85 })],
    ctx({ trend: "bearish" }), // confirmed bullish pattern vs bearish HTF
    disp(),
  );
  assert.equal(v.scannerTruthImpact.labelHint, "mixed_conditional");
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.conditional, true);
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= -10);
});

// ── 10. Target inside S/R → quality cap ─────────────────────────────────────
test("10: limited room caps display quality to at most medium", () => {
  const v = resolvePatternTruth(
    [pat({ status: "confirmed", quality: "high", confidence: 80 })],
    ctx({ nearSupportResistance: true, distanceToSrAtr: 1 }),
    disp(),
  );
  assert.notEqual(v.quality, "high");
});

// ── 11. Verdict feeds Scanner Truth (downgrade-only impact present) ──────────
test("11: verdict exposes a downgrade-only scannerTruthImpact for Scanner Truth", () => {
  const v = resolvePatternTruth([pat({ status: "forming" })], ctx(), disp());
  const i = v.scannerTruthImpact;
  assert.ok(i.confidenceCeiling <= 100);
  assert.ok(["high", "medium", "low", "none"].includes(i.qualityCeiling));
  assert.ok(i.edgeAdjustment >= -25 && i.edgeAdjustment <= 10);
});

// ── 12 & 15. Pattern can NEVER produce ready-now / execution permission ──────
test("12/15: scannerTruthImpact carries NO ready-now / execution permission field", () => {
  const supportive = resolvePatternTruth([pat({ status: "confirmed" })], ctx(), disp());
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

// ── 13. Scalp downgrades a forming pattern to conditional (no clean READY) ───
test("13: scalp engine downgrades a clean READY to FORMING when pattern is forming", () => {
  const spec: ScalpSpecInput = {
    hasBrokerTruth: true,
    tradeMode: "FULL",
    tradeAllowed: true,
    visible: true,
    marketOpen: true,
    digits: 2,
    point: 0.01,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01,
    stopsLevelPoints: 0,
    spreadPoints: 20,
    category: "synthetic",
    displayName: "Volatility 75 Index",
  };
  const scanner: ScalpScannerInput = {
    bias: "bearish",
    recommendedAction: "SELL",
    confidenceScore: 84,
    entrySniperScore: 82,
    trendStrength: 45,
    setupType: "Rejection",
    entry: 4605,
    stopLoss: 4628,
    takeProfit: 4580,
    entryZone: { low: 4602, high: 4608 },
    dataSource: "LIVE_FEED",
    // The engine fail-closes without the shared sufficiency verdict.
    sufficiency: evaluateMarketDataSufficiency({
      symbol: "Volatility 75 Index",
      timeframe: "M5",
      freshnessVerdict: "LIVE",
      availableClosedCandles: 300,
    }),
    reasonForTrade: "Rejection from resistance",
  };
  const base: ScalpEngineInput = {
    symbol: "Volatility 75 Index",
    currentPrice: 4605,
    spec,
    scanner,
    account: { balance: 1000, equity: 1000, freeMargin: 1000, leverage: 100 },
    mode: "ANY",
    riskAmount: 10,
    now: 1_780_000_000_000,
  };

  // Baseline (no pattern): READY + buildable.
  const ready = evaluateScalp(base);
  assert.equal(ready.status, "READY");
  assert.equal(ready.canBuildTrade, true);

  // Same input + a FORMING pattern impact: downgraded, never a clean READY.
  const downgraded = evaluateScalp({
    ...base,
    patternImpact: { status: "forming", qualityCeiling: 60, conditional: true, contextOnly: false, chaseRisk: false, limitedRoom: false },
  });
  assert.equal(downgraded.status, "FORMING");
  assert.equal(downgraded.canBuildTrade, false);

  // A FAILED pattern: no clean scalp at all.
  const killed = evaluateScalp({
    ...base,
    patternImpact: { status: "failed", qualityCeiling: 20, conditional: true, contextOnly: false, chaseRisk: false, limitedRoom: false },
  });
  assert.equal(killed.status, "NO_CLEAN_SCALP");
  assert.equal(killed.canBuildTrade, false);
});

// ── 14. Ruby explains confirmation + invalidation levels ────────────────────
test("14: ruby explanation narrates the confirmation and invalidation levels", () => {
  const v = resolvePatternTruth(
    [pat({ status: "forming", levels: { confirmation: 1.105, invalidation: 1.12, targets: [1.08] } })],
    ctx(),
    disp(),
  );
  assert.match(v.rubyExplanation, /1\.105/);
  assert.match(v.rubyExplanation, /1\.12/);
  assert.match(v.rubyExplanation, /forming/i);
});

// ── 17. Detector fails closed on insufficient candles ───────────────────────
test("17: detector returns insufficient + no patterns on a too-short window", () => {
  const short = Array.from({ length: 5 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 1 + i * 0.001,
    high: 1 + i * 0.001 + 0.0005,
    low: 1 + i * 0.001 - 0.0005,
    close: 1 + i * 0.001,
    isComplete: true,
    isForming: false,
  }));
  const r = detectChartPatterns(short as never);
  assert.equal(r.insufficient, true);
  assert.equal(r.patterns.length, 0);
});

// ── 18. Detection uses normalized symbol/timeframe + source/freshness ───────
test("18: buildPatternTruthVerdict returns null on an unsupported timeframe / empty candles", () => {
  const badTf = buildPatternTruthVerdict({
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

  const noCandles = buildPatternTruthVerdict({
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
  const samples: PatternOutcomeSample[] = [];
  // 6 forex WINS (high reliability).
  for (let i = 0; i < 6; i++) {
    samples.push({
      symbol: "EURUSD",
      timeframe: "1h",
      session: "london",
      isSynthetic: false,
      patternId: "head_and_shoulders",
      bias: "bearish",
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
      patternId: "head_and_shoulders",
      bias: "bearish",
      outcome: "LOSS",
      realizedR: -1,
      mfeR: 0.2,
      maeR: -1.2,
    });
  }
  const { forexIndices, synthetic } = aggregatePatternReliability(samples);
  assert.equal(forexIndices.resolvedCount, 6);
  assert.equal(synthetic.resolvedCount, 6);
  assert.notEqual(forexIndices.reliabilityScore, null);
  assert.notEqual(synthetic.reliabilityScore, null);
  assert.ok(
    (forexIndices.reliabilityScore ?? 0) > (synthetic.reliabilityScore ?? 100),
    "all-win forex must outscore all-loss synthetic",
  );
  // Adjustments stay bounded by the hard cap.
  assert.ok(Math.abs(forexIndices.rubyConfidenceAdjustment) <= MAX_CONFIDENCE_ADJUSTMENT);
  assert.ok(Math.abs(synthetic.rubyConfidenceAdjustment) <= MAX_CONFIDENCE_ADJUSTMENT);
});

test("19b: reliability score withheld until MIN_RESOLVED_FOR_SCORE resolved samples", () => {
  const few: PatternOutcomeSample[] = Array.from({ length: MIN_RESOLVED_FOR_SCORE - 1 }, () => ({
    symbol: "EURUSD",
    timeframe: "1h",
    session: "london",
    isSynthetic: false,
    patternId: "double_bottom",
    bias: "bullish",
    outcome: "WIN" as const,
    realizedR: 1,
    mfeR: 1,
    maeR: 0,
  }));
  const { forexIndices } = aggregatePatternReliability(few);
  assert.equal(forexIndices.reliabilityScore, null);
  assert.equal(forexIndices.rubyConfidenceAdjustment, 0);
});

// ── 20. Overlay hides live-ready wording when feed is stale ──────────────────
test("20: stale feed forces context-only wording (no live-ready phrasing)", () => {
  const v = resolvePatternTruth(
    [pat({ status: "confirmed", confidence: 85 })],
    ctx(),
    disp({ feedStale: true }),
  );
  assert.equal(v.scannerTruthImpact.contextOnly, true);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 0);
  assert.match(v.rubyExplanation, /context only/i);
  assert.doesNotMatch(v.rubyExplanation, /ready now|valid now/i);
});

// ── Library cross-check (Gap A) ─────────────────────────────────────────────
// The typed in-repo inventory is the SPEC the detector implements against. Lock
// that it is internally consistent and that every PatternCategory family has at
// least one catalogued entry.
test("library: every PatternCategory family has at least one catalogued entry", () => {
  const categories: PatternCategory[] = [
    "reversal",
    "continuation",
    "breakout_retest",
    "candlestick",
    "structure",
    "scalp_flare",
  ];
  // PATTERN_LIBRARY_CATEGORIES is the inventory's own declared family list.
  assert.deepEqual([...PATTERN_LIBRARY_CATEGORIES].sort(), [...categories].sort());
  for (const cat of categories) {
    const entries = PATTERN_LIBRARY.filter((e) => e.category === cat);
    assert.ok(entries.length >= 1, `category ${cat} must have >= 1 library entry`);
  }
});

test("library: entries are well-formed and ids are unique", () => {
  const ids = PATTERN_LIBRARY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "library ids must be unique");
  for (const e of PATTERN_LIBRARY) {
    assert.ok(e.id.length > 0 && e.name.length > 0, `entry ${e.id} needs id + name`);
    assert.ok(e.minCandles > 0, `entry ${e.id} needs a positive minCandles`);
    assert.ok(e.detection.length > 0, `entry ${e.id} needs detection criteria`);
    assert.ok(e.confirmation.length > 0, `entry ${e.id} needs a confirmation rule`);
    assert.ok(e.invalidation.length > 0, `entry ${e.id} needs an invalidation rule`);
    assert.ok(e.failureModes.length > 0, `entry ${e.id} needs honest failure modes`);
    assert.ok(["bullish", "bearish", "neutral", "both"].includes(e.bias));
    assert.ok(["low", "medium", "high"].includes(e.falseBreakoutRisk));
  }
  // patternLibraryIds() is the lookup the coverage test relies on.
  assert.deepEqual([...patternLibraryIds()].sort(), [...ids].sort());
});

// ── Detector coverage (Gap B) ───────────────────────────────────────────────
// Every id the detector can emit MUST be catalogued in the library, and each of
// the four newly-added category families must actually emit on a hand-built
// fixture. Deterministic geometry, no DB, no providers.

type RawC = { o: number; h: number; l: number; c: number };

function mkCandles(rows: RawC[]): never[] {
  const base = 1_700_000_000_000;
  return rows.map((row, i) => ({
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "H1",
    openTime: new Date(base + i * 3_600_000).toISOString(),
    closeTime: new Date(base + (i + 1) * 3_600_000).toISOString(),
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: 0,
    tickVolume: null,
    source: "test",
    sourceMode: "live",
    priceBasis: "MID",
    providerSymbol: null,
    brokerSymbol: null,
    isComplete: true,
    isForming: false,
  })) as never[];
}

// `n` identical flat candles — produce NO swings (so they never accidentally
// trip the reversal/structure detectors) and a small, stable ATR.
function flat(n: number, price = 100, w = 0.3): RawC[] {
  return Array.from({ length: n }, () => ({
    o: price,
    h: price + w / 2,
    l: price - w / 2,
    c: price,
  }));
}

function ids(rows: RawC[]): string[] {
  return detectChartPatterns(mkCandles(rows)).patterns.map((p) => p.id);
}

test("coverage: every detector-emitted id is catalogued in the library", () => {
  // Drive every detector across the four fixtures below + the H&S fixture; union
  // their emitted ids and assert each one exists in the inventory.
  const emitted = new Set<string>([
    ...ids(engulfingFixture()),
    ...ids(pinBarFixture()),
    ...ids(scalpFlareFixture()),
    ...ids(breakoutRetestFixture()),
  ]);
  const catalog = patternLibraryIds();
  assert.ok(emitted.size > 0, "fixtures must emit at least one pattern");
  for (const id of emitted) {
    assert.ok(catalog.has(id), `emitted id ${id} must be catalogued in the library`);
  }
});

function engulfingFixture(): RawC[] {
  return [
    ...flat(20),
    { o: 100, h: 100.1, l: 98.9, c: 99 },
    { o: 99, h: 99.1, l: 97.9, c: 98 },
    { o: 98, h: 98.1, l: 96.9, c: 97 },
    { o: 97, h: 97.1, l: 95.9, c: 96 },
    { o: 96, h: 96.1, l: 94.9, c: 95 },
    { o: 95, h: 95.2, l: 93.8, c: 94 }, // prior down candle
    { o: 93.8, h: 95.7, l: 93.6, c: 95.5 }, // bullish candle engulfs the prior body
  ];
}

test("coverage: candlestick (bullish engulfing) emits", () => {
  assert.ok(
    ids(engulfingFixture()).includes("bullish_engulfing"),
    "a down-move + engulfing bull candle must emit bullish_engulfing",
  );
});

function pinBarFixture(): RawC[] {
  return [
    ...flat(20),
    { o: 100, h: 100.1, l: 98.9, c: 99 },
    { o: 99, h: 99.1, l: 97.9, c: 98 },
    { o: 98, h: 98.1, l: 96.9, c: 97 },
    { o: 97, h: 97.1, l: 95.9, c: 96 },
    { o: 96, h: 96.1, l: 94.9, c: 95 },
    { o: 95, h: 95.2, l: 93.0, c: 95.1 }, // long lower wick, tiny body/upper wick
  ];
}

test("coverage: candlestick (bullish pin bar) emits", () => {
  assert.ok(
    ids(pinBarFixture()).includes("bullish_pin_bar"),
    "a down-move + long-lower-wick hammer must emit bullish_pin_bar",
  );
});

function scalpFlareFixture(): RawC[] {
  return [
    ...flat(25),
    { o: 100, h: 102.2, l: 99.8, c: 102 }, // wide directional expansion out of the base
  ];
}

test("coverage: scalp_flare emits on a compression -> expansion burst", () => {
  assert.ok(
    ids(scalpFlareFixture()).includes("scalp_flare_up"),
    "a tight base then a wide bull expansion candle must emit scalp_flare_up",
  );
});

function breakoutRetestFixture(): RawC[] {
  return [
    ...flat(16),
    { o: 100, h: 100.2, l: 99.8, c: 100.1 },
    { o: 100.1, h: 100.4, l: 100.0, c: 100.3 },
    { o: 100.3, h: 101.0, l: 100.2, c: 100.6 }, // swing-high #1 at 101
    { o: 100.6, h: 100.5, l: 100.0, c: 100.2 },
    { o: 100.2, h: 100.4, l: 99.9, c: 100.1 },
    { o: 100.1, h: 100.6, l: 100.0, c: 100.4 },
    { o: 100.4, h: 101.0, l: 100.3, c: 100.6 }, // swing-high #2 at 101 (clustered)
    { o: 100.6, h: 100.7, l: 100.1, c: 100.3 },
    { o: 100.3, h: 100.6, l: 100.0, c: 100.2 },
    { o: 100.2, h: 102.2, l: 100.1, c: 102.0 }, // decisive break above 101
    { o: 102.0, h: 102.1, l: 100.9, c: 101.3 }, // pull back / retest the level
    { o: 101.3, h: 101.7, l: 101.0, c: 101.5 }, // holding above the broken level
  ];
}

test("coverage: breakout_retest emits on a tested-resistance break + retest", () => {
  assert.ok(
    ids(breakoutRetestFixture()).includes("breakout_retest_up"),
    "two clustered resistance swings, a break and a retest must emit breakout_retest_up",
  );
});
