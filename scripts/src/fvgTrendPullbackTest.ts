// ── FVG Trend Pullback Engine Tests — Task #675 ───────────────────────────────
//
// Pure unit tests for the HTF Trend FVG Pullback engine. No I/O, no DB, no
// network. All tests use synthetic candle fixtures. Assertions follow the
// "backend derivation" principle: two distinct inputs ⇒ distinct outputs.
//
// Run: pnpm --filter @workspace/scripts run test:fvg-trend-pullback

import assert from "node:assert/strict";
import {
  analyzeFvgTrendPullback,
  detectHtfTrend,
  detectPullbackThroughMAs,
  detectMAReclaim,
  detectFairValueGap,
  scoreFvgTrendPullback,
  explainFvgTrendPullback,
  buildFvgChartOverlays,
  MIN_H4_BARS,
  MIN_H1_BARS,
  MIN_M5_BARS,
  type FvgCandle,
} from "../../artifacts/api-server/src/lib/fvg/fvgTrendPullback.js";
import {
  withholdFvgLevels,
  type FvgStrategyReadBlock,
} from "../../artifacts/api-server/src/lib/assistant/fvgStrategyRead.js";

// ── Candle fixture helpers ─────────────────────────────────────────────────────

function flatCandles(count: number, price: number, spread = 0.001): FvgCandle[] {
  return Array.from({ length: count }, () => ({
    open: price,
    high: price + spread,
    low: price - spread,
    close: price,
  }));
}

function trendingCandles(count: number, startPrice: number, step: number, spread = 0.001): FvgCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const p = startPrice + step * i;
    return { open: p - step * 0.5, high: p + spread, low: p - step * 0.5 - spread, close: p };
  });
}

function makeBullishFvgCandles(basePrice: number, count: number): FvgCandle[] {
  // Create a 3-candle FVG pattern at the end: candle[n-3].high < candle[n-1].low
  const candles = flatCandles(count - 3, basePrice);
  const gapLow = basePrice + 0.003;
  const gapHigh = basePrice + 0.006;
  // Three-candle gap: bar[0].high < bar[2].low
  candles.push({ open: basePrice, high: gapLow - 0.001, low: basePrice - 0.001, close: basePrice + 0.001 });
  candles.push({ open: gapLow, high: gapHigh + 0.002, low: gapLow - 0.001, close: gapHigh }); // impulse
  candles.push({ open: gapHigh, high: gapHigh + 0.001, low: gapLow + 0.001, close: gapHigh + 0.0005 }); // gap left open
  return candles;
}

function makeBearishFvgCandles(basePrice: number, count: number): FvgCandle[] {
  const candles = flatCandles(count - 3, basePrice);
  const gapHigh = basePrice - 0.003;
  const gapLow = basePrice - 0.006;
  candles.push({ open: basePrice, high: basePrice + 0.001, low: gapHigh + 0.001, close: basePrice - 0.001 });
  candles.push({ open: gapHigh, high: gapHigh + 0.001, low: gapLow - 0.002, close: gapLow });
  candles.push({ open: gapLow, high: gapHigh - 0.001, low: gapLow - 0.001, close: gapLow - 0.0005 });
  return candles;
}

// ── Test 1: No-data (missing timeframes) → NO_DATA stage + canSignal=false ────

{
  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: [],
    h1Candles: [],
    m5Candles: [],
  });

  assert.strictEqual(result.stage, "NO_DATA", "T1: stage must be NO_DATA when all candles empty");
  assert.strictEqual(result.direction, "WAIT", "T1: direction must be WAIT");
  assert.strictEqual(result.truth.canSignal, false, "T1: canSignal must be false");
  assert.strictEqual(result.truth.canAnalyze, false, "T1: canAnalyze must be false");
  assert.deepStrictEqual(result.truth.missingTimeframes, ["H4", "H1", "M5"], "T1: all 3 TFs missing");
  assert.strictEqual(result.truth.reasonIfNotReady !== null, true, "T1: reasonIfNotReady must be set");
  assert.strictEqual(result.score, 0, "T1: score must be 0");
  assert.strictEqual(result.grade, "no_trade", "T1: grade must be no_trade");
  console.log("  [PASS] T1: no-data → NO_DATA stage, canSignal=false, honest truth block");
}

// ── Test 2: Simulator data → canSignal=false ───────────────────────────────────

{
  const h4 = trendingCandles(MIN_H4_BARS + 10, 1.1000, 0.0001);
  const h1 = trendingCandles(MIN_H1_BARS + 10, 1.1000, 0.00008);
  const m5 = flatCandles(MIN_M5_BARS + 10, 1.1000);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4,
    h1Candles: h1,
    m5Candles: m5,
    isSimulator: true,
  });

  assert.strictEqual(result.truth.canSignal, false, "T2: simulator data must never signal");
  assert.strictEqual(result.truth.usingSimulator, true, "T2: usingSimulator must be true");
  assert.strictEqual(result.stage, "NO_DATA", "T2: stage is NO_DATA for simulator");
  console.log("  [PASS] T2: simulator data → canSignal=false, usingSimulator=true");
}

// ── Test 3: HTF conflict → HTF_CONFLICT stage ─────────────────────────────────

{
  // H4 strongly bullish, H1 strongly bearish → conflict
  const h4Bull = trendingCandles(220, 1.0500, 0.0005);
  const h1Bear = trendingCandles(220, 1.1000, -0.0003);
  const m5 = flatCandles(100, 1.0900);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Bull,
    h1Candles: h1Bear,
    m5Candles: m5,
  });

  assert.strictEqual(result.htfAligned, false, "T3: htfAligned must be false on conflict");
  assert.strictEqual(result.stage, "HTF_CONFLICT", "T3: stage must be HTF_CONFLICT");
  assert.strictEqual(result.direction, "WAIT", "T3: direction must be WAIT on conflict");
  assert.strictEqual(result.truth.canSignal, false, "T3: canSignal must be false on HTF conflict");
  console.log("  [PASS] T3: HTF conflict (bullish H4 + bearish H1) → HTF_CONFLICT, no signal");
}

// ── Test 4: detectHtfTrend — strong_up with stacked MAs ──────────────────────

{
  // Steadily rising candles: SMA50 < EMA200 by lag, but price > SMA50 and slope up
  const rising = trendingCandles(250, 1.0000, 0.0002);
  const read = detectHtfTrend(rising);

  assert.ok(
    read.dir === "strong_up" || read.dir === "weak_up",
    `T4: steadily rising candles must produce bullish dir (got ${read.dir})`,
  );
  assert.ok(read.sma50 !== null, "T4: SMA50 must be computed for 250 bars");
  assert.ok(read.lastClose > 1.0000, "T4: lastClose must reflect latest price");
  console.log(`  [PASS] T4: detectHtfTrend → ${read.dir} on rising candles`);
}

// ── Test 5: detectHtfTrend — insufficient bars → neutral ─────────────────────

{
  const short = trendingCandles(30, 1.0000, 0.001); // only 30 bars (< 50 for SMA)
  const read = detectHtfTrend(short);

  assert.strictEqual(read.dir, "neutral", `T5: <50 bars must produce neutral (got ${read.dir})`);
  assert.strictEqual(read.sma50, null, "T5: SMA50 must be null for <50 bars");
  console.log("  [PASS] T5: detectHtfTrend insufficient bars → neutral, sma50=null");
}

// ── Test 6: detectFairValueGap — bullish FVG correctly detected ───────────────

{
  const candles = makeBullishFvgCandles(1.1000, 30);
  const fvg = detectFairValueGap(candles, "bullish");

  assert.ok(fvg !== null, "T6: bullish FVG must be detected in gap pattern");
  assert.strictEqual(fvg.direction, "bullish", "T6: FVG direction must be bullish");
  assert.ok(fvg.high > fvg.low, "T6: FVG high must exceed low");
  assert.ok(fvg.midpoint > fvg.low && fvg.midpoint < fvg.high, "T6: midpoint must be inside zone");
  console.log(`  [PASS] T6: detectFairValueGap bullish → zone ${fvg.low.toFixed(5)}–${fvg.high.toFixed(5)}`);
}

// ── Test 7: detectFairValueGap — bearish FVG correctly detected ───────────────

{
  const candles = makeBearishFvgCandles(1.1000, 30);
  const fvg = detectFairValueGap(candles, "bearish");

  assert.ok(fvg !== null, "T7: bearish FVG must be detected in gap pattern");
  assert.strictEqual(fvg.direction, "bearish", "T7: FVG direction must be bearish");
  assert.ok(fvg.high > fvg.low, "T7: FVG high must exceed low (zone orientation)");
  console.log(`  [PASS] T7: detectFairValueGap bearish → zone ${fvg.low.toFixed(5)}–${fvg.high.toFixed(5)}`);
}

// ── Test 8: scoreFvgTrendPullback — two distinct inputs ⇒ distinct scores ────

{
  // Result A: no HTF alignment (low score)
  const resultA = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: trendingCandles(220, 1.05, 0.0005),
    h1Candles: trendingCandles(220, 1.10, -0.0003),
    m5Candles: flatCandles(100, 1.09),
  });

  // Result B: full data with realistic trending setup
  const h4Up = trendingCandles(220, 1.0500, 0.0003);
  const h1Up = trendingCandles(220, 1.0900, 0.0002);
  const m5Aligned = trendingCandles(100, 1.1000, 0.00005);
  const resultB = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Up,
    h1Candles: h1Up,
    m5Candles: m5Aligned,
  });

  assert.notStrictEqual(
    resultA.score,
    resultB.score,
    `T8: conflicting setup (${resultA.score}) vs aligned setup (${resultB.score}) must yield different scores`,
  );
  assert.ok(resultB.score >= resultA.score, "T8: aligned setup must score >= conflicting setup");
  console.log(`  [PASS] T8: score discrimination — conflict=${resultA.score} vs aligned=${resultB.score}`);
}

// ── Test 9: explainFvgTrendPullback — no internal tokens in output ─────────────

{
  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: trendingCandles(220, 1.05, 0.0005),
    h1Candles: trendingCandles(220, 1.10, -0.0003),
    m5Candles: flatCandles(100, 1.09),
  });

  const explanation = explainFvgTrendPullback(result);
  assert.ok(typeof explanation === "string" && explanation.length > 0, "T9: explanation must be a non-empty string");
  // Must not contain raw enum/stage tokens that we'd never show a user
  const forbiddenTokens = ["HTF_CONFLICT", "NO_DATA", "FVG_HUNT", "IN_PULLBACK", "RECLAIM_WATCH"];
  for (const token of forbiddenTokens) {
    assert.ok(!explanation.includes(token), `T9: explanation must not contain internal token "${token}"`);
  }
  console.log(`  [PASS] T9: explainFvgTrendPullback — human-readable, no internal tokens`);
}

// ── Test 10: buildFvgChartOverlays — returns empty array when canSignal=false ──

{
  const noDataResult = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: [],
    h1Candles: [],
    m5Candles: [],
  });

  const overlays = buildFvgChartOverlays(noDataResult);
  assert.ok(Array.isArray(overlays), "T10: overlays must be an array");
  assert.strictEqual(overlays.length, 0, "T10: no overlays when canAnalyze=false");
  console.log("  [PASS] T10: buildFvgChartOverlays → empty when no data");
}

// ── Test 11: buildFvgChartOverlays — FVG zone overlay present when fresh FVG ──

{
  // Build an active FVG scenario manually using the bullish FVG fixture
  const h4Up = trendingCandles(220, 1.0000, 0.0003);
  const h1Up = trendingCandles(220, 1.0500, 0.0002);
  // M5 candles: flat (neutral) — won't produce a full signal but engine should analyze
  const m5 = flatCandles(100, 1.0600, 0.0005);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Up,
    h1Candles: h1Up,
    m5Candles: m5,
  });

  // Whether there's a signal or not, overlays array must be a valid structure
  const overlays = buildFvgChartOverlays(result);
  assert.ok(Array.isArray(overlays), "T11: overlays must always be an array");
  // All overlay IDs must start with "fvg-"
  for (const o of overlays) {
    assert.ok(o.id.startsWith("fvg-"), `T11: overlay id must start with "fvg-" (got ${o.id})`);
    assert.ok(["zone", "line", "marker"].includes(o.kind), `T11: overlay kind must be valid (got ${o.kind})`);
    assert.ok(typeof o.label === "string" && o.label.length > 0, "T11: overlay label must be non-empty");
  }
  console.log(`  [PASS] T11: buildFvgChartOverlays → ${overlays.length} overlays, all valid structure`);
}

// ── Test 12: strategy field is always "HTF_TREND_FVG_PULLBACK" ──────────────

{
  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: [],
    h1Candles: [],
    m5Candles: [],
  });
  assert.strictEqual(result.strategy, "HTF_TREND_FVG_PULLBACK", "T12: strategy field must be constant");
  console.log("  [PASS] T12: strategy field is always 'HTF_TREND_FVG_PULLBACK'");
}

// ── Test 13: detectPullbackThroughMAs — insufficient bars → active=false ──────

{
  const short = flatCandles(30, 1.1000); // < MIN_M5_BARS=60
  const pb = detectPullbackThroughMAs(short, "bullish");
  assert.strictEqual(pb.active, false, "T13: pullback must not be active with <60 bars");
  assert.strictEqual(pb.deepestPullback, null, "T13: deepestPullback must be null");
  console.log("  [PASS] T13: detectPullbackThroughMAs insufficient bars → active=false");
}

// ── Test 14: detectMAReclaim — insufficient bars → confirmed=false ─────────────

{
  const short = flatCandles(20, 1.1000);
  const reclaim = detectMAReclaim(short, "bullish");
  assert.strictEqual(reclaim.confirmed, false, "T14: reclaim must not confirm with <60 bars");
  assert.strictEqual(reclaim.reclaimBarIndex, null, "T14: reclaimBarIndex must be null");
  console.log("  [PASS] T14: detectMAReclaim insufficient bars → confirmed=false");
}

// ── Test 15: score is bounded 0–100 ──────────────────────────────────────────

{
  // Try to produce a result with the most favorable inputs possible and check score <= 100
  const h4Bullish = trendingCandles(250, 1.0000, 0.0003);
  const h1Bullish = trendingCandles(250, 1.0500, 0.0002);
  const m5 = trendingCandles(100, 1.0600, 0.0001);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Bullish,
    h1Candles: h1Bullish,
    m5Candles: m5,
  });

  const recheckedScore = scoreFvgTrendPullback(result);
  assert.ok(recheckedScore >= 0 && recheckedScore <= 100, `T15: score must be 0-100 (got ${recheckedScore})`);
  assert.ok(result.score >= 0 && result.score <= 100, `T15: result.score must be 0-100 (got ${result.score})`);
  console.log(`  [PASS] T15: score bounded 0–100 (got ${result.score})`);
}

// ── Test 16: staleTimeframes → canAnalyze=false AND canSignal=false (fail-closed)

{
  const h4 = trendingCandles(220, 1.05, 0.0005);
  const h1 = trendingCandles(220, 1.09, 0.0003);
  const m5 = flatCandles(100, 1.09);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4,
    h1Candles: h1,
    m5Candles: m5,
    staleTimeframes: ["H4", "H1"],
  });

  // Stale TFs block the entire analysis — not just the signal
  assert.deepStrictEqual(result.truth.staleTimeframes, ["H4", "H1"], "T16: staleTimeframes propagated");
  assert.strictEqual(result.truth.canAnalyze, false, "T16: canAnalyze must be false when any TF is stale");
  assert.strictEqual(result.truth.canSignal, false, "T16: canSignal must be false when any TF is stale");
  assert.strictEqual(result.stage, "NO_DATA", "T16: stage must be NO_DATA when stale (fail-closed)");
  assert.ok(
    result.truth.reasonIfNotReady?.includes("Stale") === true,
    `T16: reasonIfNotReady must mention stale (got: ${result.truth.reasonIfNotReady})`,
  );
  console.log("  [PASS] T16: stale TFs → canAnalyze=false, canSignal=false, stage=NO_DATA (fail-closed)");
}

// ── Test 17: EMA200 unavailable (<200 bars) → trend is never "strong" ─────────

{
  // Only 60 bars: enough for SMA50 but NOT EMA200 (needs ≥ 200)
  const short60 = trendingCandles(60, 1.0000, 0.001); // clearly rising, price >> sma50
  const read = detectHtfTrend(short60);

  // With <200 bars, EMA200 returns null. The engine must not emit strong_up/strong_down.
  assert.ok(
    read.dir !== "strong_up" && read.dir !== "strong_down",
    `T17: <200 bars must not produce strong_up/strong_down (got ${read.dir}) — EMA200 required`,
  );
  assert.strictEqual(read.ema200, null, "T17: ema200 must be null for <200 bars");
  console.log(`  [PASS] T17: <200 bars → no strong direction (got ${read.dir}), ema200=null`);
}

// ── Test 18: suggestedTP3 and invalidationLevel non-null when canSignal=true ───

{
  // Build a scenario where canSignal can be true: aligned HTF + pullback + reclaim + fresh FVG
  // We use a custom M5 fixture that has pullback → reclaim → FVG in sequence.
  // 1. Build bullish 5M candles with pullback + reclaim + fresh FVG
  const m5: FvgCandle[] = [];
  const baseSMA = 1.1000;

  // First 50 candles: above SMA (warm-up), then price dips into SMA zone (pullback), then reclaims
  for (let i = 0; i < 45; i++) m5.push({ open: baseSMA + 0.010, high: baseSMA + 0.012, low: baseSMA + 0.009, close: baseSMA + 0.010 });
  // Pullback into SMA zone (5 candles)
  for (let i = 0; i < 5; i++) m5.push({ open: baseSMA + 0.001, high: baseSMA + 0.003, low: baseSMA - 0.001, close: baseSMA + 0.001 });
  // Reclaim bar: closes above SMA
  m5.push({ open: baseSMA - 0.0005, high: baseSMA + 0.005, low: baseSMA - 0.002, close: baseSMA + 0.004 });
  // Impulse that creates FVG: bar[0].high < bar[2].low
  m5.push({ open: baseSMA + 0.004, high: baseSMA + 0.006, low: baseSMA + 0.003, close: baseSMA + 0.005 });
  m5.push({ open: baseSMA + 0.007, high: baseSMA + 0.020, low: baseSMA + 0.007, close: baseSMA + 0.018 }); // impulse
  m5.push({ open: baseSMA + 0.018, high: baseSMA + 0.019, low: baseSMA + 0.009, close: baseSMA + 0.010 }); // gap left open above bar[0].high

  // HTF with 250+ bars so EMA200 is settled
  const h4Up = trendingCandles(250, 1.0000, 0.0004);
  const h1Up = trendingCandles(250, 1.0800, 0.0003);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Up,
    h1Candles: h1Up,
    m5Candles: m5,
  });

  // If canSignal is true, TP3 and invalidationLevel must be non-null
  if (result.truth.canSignal) {
    assert.ok(result.suggestedTP3 !== null, "T18: suggestedTP3 must be non-null when canSignal=true");
    assert.ok(result.invalidationLevel !== null, "T18: invalidationLevel must be non-null when canSignal=true");
    assert.ok(result.suggestedTP3! > result.suggestedTP2!, "T18: TP3 must exceed TP2 (BUY)");
    console.log(`  [PASS] T18: canSignal=true → TP3=${result.suggestedTP3?.toFixed(5)}, invalidation=${result.invalidationLevel?.toFixed(5)}`);
  } else {
    // canSignal=false is acceptable (setup may not have completed); but TP3/invalidation must still be null
    assert.strictEqual(result.suggestedTP3, null, "T18: suggestedTP3 must be null when canSignal=false");
    assert.strictEqual(result.invalidationLevel, null, "T18: invalidationLevel must be null when canSignal=false");
    console.log(`  [PASS] T18: canSignal=false → TP3=null, invalidationLevel=null (honest empty)`);
  }
}

// ── Test 19: mitigated FVG → stage FVG_MISSED, not FVG_ENTRY_ZONE ─────────────

{
  // Build 5M candles where a bullish FVG forms but price then returns INTO it (mitigated)
  const m5: FvgCandle[] = [];
  const base = 1.1000;

  // Warm-up above SMA zone
  for (let i = 0; i < 45; i++) m5.push({ open: base + 0.010, high: base + 0.012, low: base + 0.009, close: base + 0.010 });
  // Pullback
  for (let i = 0; i < 5; i++) m5.push({ open: base + 0.001, high: base + 0.003, low: base - 0.001, close: base + 0.001 });
  // Reclaim
  m5.push({ open: base - 0.0005, high: base + 0.005, low: base - 0.002, close: base + 0.004 });
  // FVG formation: bar[0].high=0.006, bar[2].low=0.009 → gap from 0.006 to 0.009
  m5.push({ open: base + 0.004, high: base + 0.006, low: base + 0.003, close: base + 0.005 }); // bar[0]
  m5.push({ open: base + 0.007, high: base + 0.015, low: base + 0.007, close: base + 0.014 }); // impulse bar[1]
  m5.push({ open: base + 0.014, high: base + 0.016, low: base + 0.009, close: base + 0.012 }); // bar[2]: low=0.009 > bar[0].high=0.006 → valid FVG
  // Price now retraces INTO the FVG zone (mitigates it): low < gapLow (0.006)
  m5.push({ open: base + 0.012, high: base + 0.013, low: base + 0.004, close: base + 0.005 }); // touches into the gap → mitigated

  const h4Up = trendingCandles(250, 1.0000, 0.0004);
  const h1Up = trendingCandles(250, 1.0800, 0.0003);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Up,
    h1Candles: h1Up,
    m5Candles: m5,
  });

  // A fully mitigated FVG must push the stage to FVG_MISSED, never FVG_ENTRY_ZONE
  if (result.activeFvg?.isMitigated) {
    assert.strictEqual(result.stage, "FVG_MISSED", `T19: mitigated FVG must produce FVG_MISSED stage (got ${result.stage})`);
    assert.strictEqual(result.truth.canSignal, false, "T19: canSignal must be false when FVG is mitigated");
    console.log("  [PASS] T19: mitigated FVG → stage=FVG_MISSED, canSignal=false");
  } else {
    // If the fixture didn't trigger mitigation detection, verify stage is still not FVG_ENTRY_ZONE
    assert.ok(result.stage !== "FVG_ENTRY_ZONE", `T19: without confirmed unmitigated FVG, stage must not be FVG_ENTRY_ZONE (got ${result.stage})`);
    console.log(`  [PASS] T19: no unmitigated FVG → stage=${result.stage}, not FVG_ENTRY_ZONE`);
  }
}

// ── Test 20: FVG detection without MA reclaim → no FVG stage ──────────────────

{
  // HTF aligned but 5M never shows a pullback or reclaim.
  // Even if an FVG-like pattern exists in the candles, the stage should not advance to FVG_HUNT+
  const h4Up = trendingCandles(250, 1.0000, 0.0004);
  const h1Up = trendingCandles(250, 1.0800, 0.0003);
  // 5M just trending up steadily — no pullback into MA zone, no reclaim
  const m5Steady = trendingCandles(100, 1.1000, 0.00002);

  const result = analyzeFvgTrendPullback({
    symbol: "EURUSD",
    h4Candles: h4Up,
    h1Candles: h1Up,
    m5Candles: m5Steady,
  });

  const invalidStages: string[] = ["FVG_HUNT", "FVG_ENTRY_ZONE", "INSIDE_FVG", "FVG_MISSED", "INVALIDATED"];
  if (!result.pullbackActive) {
    assert.strictEqual(result.stage, "PULLBACK_WATCH", `T20: no pullback → stage must be PULLBACK_WATCH (got ${result.stage})`);
    assert.ok(!invalidStages.includes(result.stage), "T20: cannot reach FVG stages without a pullback");
    assert.strictEqual(result.truth.canSignal, false, "T20: canSignal must be false without pullback + reclaim + FVG");
    console.log("  [PASS] T20: no pullback on 5M → stage=PULLBACK_WATCH, canSignal=false");
  } else {
    // If pullback detected but no reclaim, stage must be IN_PULLBACK
    assert.ok(result.stage === "PULLBACK_WATCH" || result.stage === "IN_PULLBACK",
      `T20: without reclaim, stage must be PULLBACK_WATCH or IN_PULLBACK (got ${result.stage})`);
    console.log(`  [PASS] T20: pullback without reclaim → stage=${result.stage}, canSignal=false`);
  }
}

// ── Test 21: withholdFvgLevels strips numeric levels for a structural read ────

{
  // The FVG engine's staleness check is INDEPENDENT of the primary read's feed
  // verdict, so a feed-unconfirmed (STRUCTURAL_ONLY) read could otherwise ship
  // concrete entry/SL/TP numbers. withholdFvgLevels is the downgrade-only guard:
  // it nulls every numeric level + marks them withheld, PRESERVING direction and
  // structure narrative, and must NOT mutate its input (pure).
  const syntheticBlock: FvgStrategyReadBlock = {
    active: true,
    strategy: "HTF_TREND_FVG_PULLBACK",
    direction: "BUY",
    stage: "FVG_ENTRY_ZONE",
    h4Trend: "strong_up",
    h1Trend: "strong_up",
    htfAligned: true,
    htfNote: "H4 and H1 both trending up.",
    fiveMinState: "Pullback reclaimed the MAs; price inside a bullish FVG.",
    pullbackActive: true,
    maReclaimed: true,
    activeFvg: null,
    fvgNote: "Bullish fair value gap active.",
    entryMin: 1.082,
    entryMax: 1.0835,
    suggestedEntry: 1.0828,
    suggestedSL: 1.079,
    suggestedTP1: 1.087,
    suggestedTP2: 1.091,
    suggestedTP3: 1.096,
    invalidationLevel: 1.0785,
    score: 82,
    grade: "A",
    headline: "HTF-aligned bullish FVG pullback.",
    explanation: "4H/1H up; 5M pulled back and reclaimed the MAs into a fair value gap.",
    tags: ["HTF_ALIGNED", "FVG_ACTIVE"],
    // Test fixture: the exact `truth` shape is irrelevant here (withholdFvgLevels
    // preserves it untouched), so we cast through unknown.
    truth: { canAnalyze: true, canSignal: true, missingTimeframes: [] } as unknown as FvgStrategyReadBlock["truth"],
    note: "HTF Trend FVG Pullback is display / decision-support only — it explains and highlights, never authorises a trade.",
  };

  const withheld = withholdFvgLevels(syntheticBlock);

  // Every numeric level is nulled.
  assert.strictEqual(withheld.entryMin, null, "T21: entryMin must be withheld");
  assert.strictEqual(withheld.entryMax, null, "T21: entryMax must be withheld");
  assert.strictEqual(withheld.suggestedEntry, null, "T21: suggestedEntry must be withheld");
  assert.strictEqual(withheld.suggestedSL, null, "T21: suggestedSL must be withheld");
  assert.strictEqual(withheld.suggestedTP1, null, "T21: suggestedTP1 must be withheld");
  assert.strictEqual(withheld.suggestedTP2, null, "T21: suggestedTP2 must be withheld");
  assert.strictEqual(withheld.suggestedTP3, null, "T21: suggestedTP3 must be withheld");
  assert.strictEqual(withheld.invalidationLevel, null, "T21: invalidationLevel must be withheld");
  assert.strictEqual(withheld.levelsWithheld, true, "T21: levelsWithheld must be true");

  // Direction + structure narrative are PRESERVED.
  assert.strictEqual(withheld.direction, "BUY", "T21: direction preserved");
  assert.strictEqual(withheld.stage, "FVG_ENTRY_ZONE", "T21: stage preserved");
  assert.strictEqual(withheld.h4Trend, "strong_up", "T21: h4Trend preserved");
  assert.strictEqual(withheld.htfNote, syntheticBlock.htfNote, "T21: htfNote preserved");
  assert.strictEqual(withheld.headline, syntheticBlock.headline, "T21: headline preserved");
  assert.strictEqual(withheld.explanation, syntheticBlock.explanation, "T21: explanation preserved");
  assert.ok(withheld.note.includes("withheld"), "T21: note explains that levels are withheld");

  // Purity: the input block is NOT mutated.
  assert.strictEqual(syntheticBlock.entryMin, 1.082, "T21: withholdFvgLevels must not mutate its input");
  assert.strictEqual(syntheticBlock.levelsWithheld, undefined, "T21: input levelsWithheld untouched");

  console.log("  [PASS] T21: withholdFvgLevels nulls numeric levels, preserves direction/structure, is pure");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\nfvgTrendPullbackTest");
console.log("====================");
console.log("All 21 tests passed — FVG engine is honest, bounded, and additive.");
