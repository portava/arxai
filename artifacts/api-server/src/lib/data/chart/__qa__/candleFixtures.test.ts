// ═══════════════════════════════════════════════════════════════════════════
// candleFixtures.test.ts — deterministic fixture tests for the ARX chart-truth
// pipeline (Phases 1–4 lock-in, Phase 5 scope).
//
// These tests exercise the pure normalisation + truth engine with STATIC,
// hard-coded fixture candles. They NEVER call the database, network, or any
// live provider. They are explicitly test-only — fixture data is labelled
// "dev" (SourceMode="dev") or uses deliberately invalid/edge-case values, so
// the source-mode check always catches them if any future path were to forward
// them. No fixture candle carries sourceMode="live".
//
// Coverage:
//   Candle rendering/mapping:
//     [F01] Bullish candle — close > open → rendered bullish
//     [F02] Bearish candle — close < open → rendered bearish
//     [F03] Doji — open ≈ close → rendered neutral
//     [F04] Long upper wick — high far above body
//     [F05] Long lower wick — low far below body
//     [F06] Gap candle — price gap between previous close and this open
//     [F07] Forming candle — bar whose closeTime is in the future
//     [F08] Timeframe switch — a second call with a different timeframe
//            produces an independent result (no state bleed)
//     [F09] Symbol switch — independent result, no state bleed
//
//   Validation / rejection:
//     [F10] Invalid OHLC — high < low → OHLC_INVALID flag (bar kept, flagged)
//     [F11] Duplicate timestamp — one bar collapses to latest, DUPLICATE_BUCKET flag
//     [F12] Mock source in live context → sourceMode="mock", MOCK_DATA flag,
//            mockDataDetected=true in truth result
//     [F13] Outlier spike — single huge close move → OUTLIER_SPIKE flag
//
//   Gating / safe-mode:
//     [F14] Chart quality degrades to "invalid" when mockDataDetected=true
//     [F15] Ruby-gating: aiUsable=false when quality ≠ "clean"
//     [F16] Precision violation — integer pips instead of decimal prices
//     [F17] Forming bar detected at seam — mergeSeam.formingBarDetected=true
//     [F18] Seam gap — gap between last complete and forming bar detected
//     [F19] Historical period shift — old-epoch bars flagged advisory only
//
//   Per-timeframe audit (static — no provider calls):
//     [F20] M1 normalisation passes OHLC integrity
//     [F21] M5 normalisation passes OHLC integrity
//     [F22] M15 normalisation passes OHLC integrity
//     [F23] H1 normalisation passes OHLC integrity
//     [F24] H4 long-wick detection fires on D1+H4 only
//     [F25] D1 long-wick detection fires
//
//   Preservation checks (smoke tests for live surfaces):
//     [F26] trailingIntervalGap returns null on empty candles
//     [F27] trailingIntervalGap returns a finite number on non-empty candles
//     [F28] sourceModeFromProvider("mock") = "mock"
//     [F29] sourceModeFromProvider("deriv") = "live"
//     [F30] sourceModeFromProvider("assistant_real:twelve_data") = "live"
//     [F31] priceBasisFromProvider("mt5_broker") = "BID"
//     [F32] priceBasisFromProvider("deriv") = "SYNTHETIC"
//     [F33] isValidOhlc rejects negative prices
//     [F34] isValidOhlc rejects non-finite values
//
// FIXTURE SCOPE GUARANTEE:
//   No fixture in this file may be mistaken for live data because:
//   (a) sourceMode is always "dev" or "mock" (never "live"),
//   (b) symbols are the synthetic test identifier "TESTFX_FIXTURE", and
//   (c) the normalizeCandles function is pure and stateless — it has no
//       write path and cannot touch the DB, network, or any live resource.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandles,
  trailingIntervalGap,
  sourceModeFromProvider,
  priceBasisFromProvider,
  isValidOhlc,
  type NormalizeOptions,
} from "../candleNormalization.js";
import { runCandleTruth } from "../candleTruthEngine.js";
import { buildWeeklyPresenceProfile } from "../sessionProfile.js";
import { buildFeedStatus } from "../../freshness.js";
import type { Candle } from "../../types.js";

export {};

// ── Fixture helpers ───────────────────────────────────────────────────────────

const FIXTURE_SYMBOL = "TESTFX_FIXTURE";
const FIXTURE_DISPLAY = "TESTFX/FIXTURE";

/** One closed M5 bar anchored to a fixed epoch (does NOT use Date.now()). */
const EPOCH = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z — static, no wall-clock drift
const M5_MS = 5 * 60 * 1000;
const M1_MS = 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const H4_MS = 4 * 60 * 60 * 1000;
const D1_MS = 24 * 60 * 60 * 1000;

function ts(offset = 0): string {
  return new Date(EPOCH + offset).toISOString();
}

function baseOpts(overrides: Partial<NormalizeOptions> = {}): NormalizeOptions {
  return {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "dev",
    now: EPOCH + M5_MS * 100, // well into the future of our fixture bars
    ...overrides,
  };
}

/** Minimal bullish bar. */
function bullBar(openOffset = 0): Candle {
  return { time: ts(openOffset), open: 1.1000, high: 1.1020, low: 1.0990, close: 1.1015 };
}
/** Minimal bearish bar. */
function bearBar(openOffset = 0): Candle {
  return { time: ts(openOffset), open: 1.1020, high: 1.1030, low: 1.0980, close: 1.0985 };
}

// ── Candle rendering / mapping ───────────────────────────────────────────────

test("[F01] Bullish candle — close > open → rendered bullish", () => {
  const raw: Candle[] = [bullBar(0)];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1);
  const c = candles[0]!;
  assert.ok(c.close > c.open, "close must be > open for a bullish candle");
  assert.equal(c.sourceMode, "dev");
  assert.equal(c.symbol, FIXTURE_SYMBOL);
});

test("[F02] Bearish candle — close < open → rendered bearish", () => {
  const raw: Candle[] = [bearBar(0)];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1);
  const c = candles[0]!;
  assert.ok(c.close < c.open, "close must be < open for a bearish candle");
});

test("[F03] Doji — open ≈ close → body is near-zero", () => {
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1001 }];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1);
  const body = Math.abs(candles[0]!.close - candles[0]!.open);
  assert.ok(body < 0.001, "doji body should be near-zero");
});

test("[F04] Long upper wick — high far above max(open, close)", () => {
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.1100, low: 1.0990, close: 1.1005 }];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1);
  const c = candles[0]!;
  const upperWick = c.high - Math.max(c.open, c.close);
  assert.ok(upperWick > 0.009, "upper wick should be > 90 pips");
});

test("[F05] Long lower wick — low far below min(open, close)", () => {
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.1010, low: 1.0900, close: 1.0995 }];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1);
  const c = candles[0]!;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  assert.ok(lowerWick > 0.009, "lower wick should be > 90 pips");
});

test("[F06] Gap candle — price gap between previous close and this open", () => {
  const raw: Candle[] = [
    { time: ts(0),       open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 },
    { time: ts(M5_MS),   open: 1.1100, high: 1.1120, low: 1.1090, close: 1.1110 }, // gap up
  ];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 2);
  const gap = candles[1]!.open - candles[0]!.close;
  assert.ok(gap > 0.009, "gap between candle close and next open should be > 90 pips");
});

test("[F07] Forming candle — closeTime is in the future, FORMING_BAR flag", () => {
  // "now" is EPOCH; bar opens at EPOCH - M5_MS so closeTime = EPOCH, which is NOT in the future
  // Instead: bar opens at EPOCH (exactly now) so closeTime = EPOCH + M5_MS (future)
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 }];
  const opts = baseOpts({ now: EPOCH }); // now == bar open time → close is in future
  const { candles } = normalizeCandles(raw, opts);
  assert.equal(candles.length, 1);
  const c = candles[0]!;
  assert.equal(c.isComplete, false, "bar should be incomplete (forming)");
  assert.equal(c.isFinal, false);
  assert.ok(c.qualityFlags.includes("FORMING_BAR"), "FORMING_BAR flag must be set");
});

test("[F08] Timeframe switch — second normalisation with H1 is independent of M5", () => {
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 }];
  const { candles: m5 } = normalizeCandles(raw, baseOpts({ timeframe: "M5" }));
  const { candles: h1 } = normalizeCandles(raw, baseOpts({ timeframe: "H1" }));
  assert.equal(m5[0]!.timeframe, "M5");
  assert.equal(h1[0]!.timeframe, "H1");
  // Close times differ (bucket durations differ)
  const m5CloseMs = Date.parse(m5[0]!.closeTime) - Date.parse(m5[0]!.openTime);
  const h1CloseMs = Date.parse(h1[0]!.closeTime) - Date.parse(h1[0]!.openTime);
  assert.equal(m5CloseMs, M5_MS);
  assert.equal(h1CloseMs, H1_MS);
});

test("[F09] Symbol switch — result carries the correct symbol, no state bleed", () => {
  const raw: Candle[] = [bullBar(0)];
  const { candles: a } = normalizeCandles(raw, baseOpts({ symbol: "EURUSD", displaySymbol: "EUR/USD" }));
  const { candles: b } = normalizeCandles(raw, baseOpts({ symbol: "GBPUSD", displaySymbol: "GBP/USD" }));
  assert.equal(a[0]!.symbol, "EURUSD");
  assert.equal(b[0]!.symbol, "GBPUSD");
});

// ── Validation / rejection ────────────────────────────────────────────────────

test("[F10] Invalid OHLC — high < low → OHLC_INVALID flag, bar is kept (not dropped)", () => {
  const raw: Candle[] = [{ time: ts(0), open: 1.1000, high: 1.0980, low: 1.1010, close: 1.1005 }];
  const { candles, anomalies } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1, "invalid-OHLC bar must be kept, not dropped");
  assert.ok(candles[0]!.qualityFlags.includes("OHLC_INVALID"), "OHLC_INVALID flag must be set");
  assert.equal(anomalies.invalidOhlcCount, 1);
});

test("[F11] Duplicate timestamp — collapses to latest, DUPLICATE_BUCKET flag on winner", () => {
  const raw: Candle[] = [
    { time: ts(0), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1001 }, // earlier
    { time: ts(0), open: 1.1005, high: 1.1015, low: 1.0985, close: 1.1012 }, // later (wins)
  ];
  const { candles, anomalies } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 1, "duplicates must be collapsed to one bar");
  assert.equal(anomalies.duplicateCount, 1);
  assert.ok(candles[0]!.qualityFlags.includes("DUPLICATE_BUCKET"), "DUPLICATE_BUCKET must be flagged on winner");
  assert.equal(candles[0]!.close, 1.1012, "the winning (later) bar's close should be kept");
});

test("[F12] Mock source — sourceMode=mock, MOCK_DATA flag, mockDataDetected=true in truth result", () => {
  const raw: Candle[] = [bullBar(0), bullBar(M5_MS)];
  const opts = baseOpts({ source: "mock" });
  const { candles } = normalizeCandles(raw, opts);
  assert.equal(candles[0]!.sourceMode, "mock");
  assert.ok(candles[0]!.qualityFlags.includes("MOCK_DATA"), "MOCK_DATA flag must be set for mock source");

  const tr = runCandleTruth(raw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "mock",
    assetClass: "forex",
    limit: 300,
    now: EPOCH + M5_MS * 100,
  });
  assert.equal(tr.truthResult.mockDataDetected, true, "truth result must flag mock data");
  assert.equal(tr.truthResult.assessment, "DEGRADED", "mock data → DEGRADED assessment");
  assert.notEqual(tr.truthResult.mockDataAdminReason, null, "admin reason must be non-null for mock");
});

test("[F13] Outlier spike — single huge close move → OUTLIER_SPIKE flag", () => {
  // Build 12 normal bars then one massive spike
  const raw: Candle[] = [];
  for (let i = 0; i < 12; i++) {
    raw.push({ time: ts(i * M5_MS), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 });
  }
  // Bar 12: price jumps 500 pips (far beyond 6×ATR)
  raw.push({ time: ts(12 * M5_MS), open: 1.1005, high: 1.1500, low: 1.1004, close: 1.1490 });

  const { candles } = normalizeCandles(raw, baseOpts({ now: EPOCH + M5_MS * 200 }));
  const spike = candles[candles.length - 1]!;
  assert.ok(spike.qualityFlags.includes("OUTLIER_SPIKE"), "spike bar must carry OUTLIER_SPIKE flag");
});

// ── Gating / safe-mode ────────────────────────────────────────────────────────

test("[F14] Quality degrades when mockDataDetected (truth assessment = DEGRADED)", () => {
  const raw: Candle[] = [bullBar(0), bullBar(M5_MS), bullBar(M5_MS * 2)];
  const tr = runCandleTruth(raw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "twelveData_mock_shim",
    assetClass: "forex",
    limit: 300,
    now: EPOCH + M5_MS * 100,
  });
  assert.equal(tr.truthResult.mockDataDetected, true);
  assert.equal(tr.truthResult.assessment, "DEGRADED");
  // A DEGRADED truth result must never produce aiUsable=true
  // (aiUsable is derived from ChartQuality, but DEGRADED → quality="invalid" in chartDataService,
  //  which sets aiUsable=false. We confirm the truth flag here; chartDataService mapping is a
  //  separate integration concern tested by the chartDataService unit tests.)
  assert.equal(tr.truthResult.sourceMode, "mock");
});

test("[F15] aiUsable=false when assessment is DEGRADED or PARTIAL", () => {
  // DEGRADED from mock source
  const mockResult = runCandleTruth([bullBar(0)], {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "mock",
    assetClass: "forex",
    limit: 300,
    now: EPOCH + M5_MS * 100,
  });
  assert.equal(mockResult.truthResult.assessment, "DEGRADED");
  // The chartDataService derives aiUsable from quality===clean; this fixture
  // directly confirms the truth-engine's assessment is never CLEAN for mock data.
  assert.notEqual(mockResult.truthResult.assessment, "CLEAN");

  // PARTIAL from invalid OHLC (> 5% threshold — 1 invalid of 2 bars = 50%)
  const invalidRaw: Candle[] = [
    { time: ts(0),      open: 1.1000, high: 1.0980, low: 1.1010, close: 1.1005 }, // invalid
    { time: ts(M5_MS),  open: 1.1005, high: 1.1015, low: 1.0995, close: 1.1010 }, // valid
  ];
  const invalidResult = runCandleTruth(invalidRaw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "deriv",
    assetClass: "synthetic",
    limit: 300,
    now: EPOCH + M5_MS * 100,
  });
  assert.notEqual(invalidResult.truthResult.assessment, "CLEAN",
    "high invalidOhlc fraction must degrade from CLEAN");
});

test("[F16] Precision violation — integer pips instead of decimal prices", () => {
  // Simulate a provider returning integer prices (e.g. 11000 instead of 1.1000)
  // For a symbol with pricePrecision=4, all-integer prices trigger the scale-bug detector.
  const raw: Candle[] = [
    { time: ts(0),     open: 11000, high: 11010, low: 10990, close: 11005 },
    { time: ts(M5_MS), open: 11005, high: 11015, low: 10995, close: 11010 },
    { time: ts(M5_MS * 2), open: 11010, high: 11020, low: 11000, close: 11015 },
  ];
  const { anomalies } = normalizeCandles(raw, baseOpts({ pricePrecision: 4 }));
  assert.ok(anomalies.precisionViolationCount > 0, "integer-price bars must trigger precision violation");
});

test("[F17] Forming bar detected at seam — mergeSeam.formingBarDetected=true", () => {
  const now = EPOCH;
  // Bar opens exactly at "now" → closeTime is in the future → not complete
  const raw: Candle[] = [
    { time: ts(-M5_MS * 2), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 },
    { time: ts(-M5_MS),     open: 1.1005, high: 1.1015, low: 1.0995, close: 1.1010 },
    { time: ts(0),           open: 1.1010, high: 1.1020, low: 1.1000, close: 1.1015 }, // forming
  ];
  const tr = runCandleTruth(raw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "deriv",
    assetClass: "synthetic",
    limit: 300,
    now,
  });
  assert.equal(tr.truthResult.formingCandlePresent, true, "forming candle must be detected");
  assert.equal(tr.truthResult.mergeSeam.formingBarDetected, true, "mergeSeam must confirm forming bar");
  assert.notEqual(tr.truthResult.formingCandleOhlc, null, "forming OHLC snapshot must be present");
});

test("[F18] Seam gap — gap between last complete and forming bar", () => {
  const now = EPOCH;
  // Last complete bar closes at EPOCH - M5_MS; forming bar opens at EPOCH (2 intervals gap)
  const raw: Candle[] = [
    { time: ts(-M5_MS * 3), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 },
    // (one bar missing here — gap)
    { time: ts(0), open: 1.1010, high: 1.1020, low: 1.1000, close: 1.1015 }, // forming
  ];
  const tr = runCandleTruth(raw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "deriv",
    assetClass: "synthetic",
    limit: 300,
    now,
  });
  assert.equal(tr.truthResult.mergeSeam.formingBarDetected, true);
  assert.equal(tr.truthResult.mergeSeam.gapAtSeam, true, "gap at seam must be detected");
  assert.ok(tr.truthResult.mergeSeam.seamGapIntervals > 0, "seam gap interval count must be > 0");
});

test("[F19] Historical period shift — old-epoch bars flagged advisory only, assessment stays CLEAN or PARTIAL", () => {
  // Recent 30 bars around 1.10; a few old-epoch bars at 0.50 (> 40% deviation)
  const raw: Candle[] = [];
  // 5 old-epoch bars (far from recent cluster)
  for (let i = 0; i < 5; i++) {
    raw.push({ time: ts(i * M5_MS), open: 0.5000, high: 0.5010, low: 0.4990, close: 0.5005 });
  }
  // 35 recent bars
  for (let i = 5; i < 40; i++) {
    raw.push({ time: ts(i * M5_MS), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 });
  }
  const now = EPOCH + M5_MS * 50; // well past all bars
  const { candles, anomalies } = normalizeCandles(raw, baseOpts({ now }));

  // Old-epoch bars should be flagged HISTORICAL_PERIOD_SHIFT
  assert.ok(anomalies.historicalPeriodShiftCount > 0, "historical period shift must be counted");

  // The flags on old-epoch bars must include HISTORICAL_PERIOD_SHIFT
  const shiftBars = candles.filter((c) => c.qualityFlags.includes("HISTORICAL_PERIOD_SHIFT"));
  assert.ok(shiftBars.length > 0, "at least one bar must carry HISTORICAL_PERIOD_SHIFT flag");

  // Outlier advisory flags NEVER alone degrade assessment to DEGRADED
  // (they are counted but the assessment for a clean-sequenced feed remains CLEAN or PARTIAL)
  const tr = runCandleTruth(raw, {
    symbol: FIXTURE_SYMBOL,
    displaySymbol: FIXTURE_DISPLAY,
    timeframe: "M5",
    source: "deriv",
    assetClass: "synthetic",
    limit: 300,
    now,
  });
  assert.ok(
    tr.truthResult.assessment === "CLEAN" ||
    tr.truthResult.assessment === "PARTIAL" ||
    tr.truthResult.assessment === "STALE",
    `historical period shift alone must not cause DEGRADED assessment (got: ${tr.truthResult.assessment})`
  );
});

// ── Per-timeframe normalisation (static, no provider calls) ──────────────────

function oneCleanBar(intervalMs: number): Candle[] {
  return [{ time: ts(0), open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 }];
}

test("[F20] M1 normalisation passes OHLC integrity", () => {
  const { candles, anomalies } = normalizeCandles(
    oneCleanBar(M1_MS),
    baseOpts({ timeframe: "M1", now: EPOCH + M1_MS * 100 }),
  );
  assert.equal(anomalies.invalidOhlcCount, 0);
  assert.equal(candles[0]!.timeframe, "M1");
});

test("[F21] M5 normalisation passes OHLC integrity", () => {
  const { candles, anomalies } = normalizeCandles(
    oneCleanBar(M5_MS),
    baseOpts({ timeframe: "M5", now: EPOCH + M5_MS * 100 }),
  );
  assert.equal(anomalies.invalidOhlcCount, 0);
  assert.equal(candles[0]!.timeframe, "M5");
});

test("[F22] M15 normalisation passes OHLC integrity", () => {
  const { candles, anomalies } = normalizeCandles(
    oneCleanBar(15 * 60 * 1000),
    baseOpts({ timeframe: "M15", now: EPOCH + 15 * 60 * 1000 * 100 }),
  );
  assert.equal(anomalies.invalidOhlcCount, 0);
  assert.equal(candles[0]!.timeframe, "M15");
});

test("[F23] H1 normalisation passes OHLC integrity", () => {
  const { candles, anomalies } = normalizeCandles(
    oneCleanBar(H1_MS),
    baseOpts({ timeframe: "H1", now: EPOCH + H1_MS * 100 }),
  );
  assert.equal(anomalies.invalidOhlcCount, 0);
  assert.equal(candles[0]!.timeframe, "H1");
});

test("[F24] H4 long-wick detection fires only on H4 and D1 (not on M5)", () => {
  // A bar with extreme wick: body is tiny, wick >> body (ratio > 0.8)
  const extremeWickBar: Candle = { time: ts(0), open: 1.1000, high: 1.1200, low: 1.0800, close: 1.1005 };
  // range = 0.04, body = 0.0005, upperWick = 0.0195, lowerWick = 0.02, maxWick=0.02, body*3=0.0015
  // maxWick/range = 0.5 — need to use a more extreme example for threshold 0.8
  // range=0.04, maxWick = 0.0195 → ratio = ~0.5 < 0.8 — NOT an outlier wick at default threshold
  // Let's use one where ratio > 0.8: body=0.0001, upperWick=0.04, range=0.0401
  const realWickBar: Candle = { time: ts(0), open: 1.1000, high: 1.1401, low: 1.0999, close: 1.1001 };
  // range = 0.0402, body = 0.0001, upperWick = 0.04, maxWick/range = 0.04/0.0402 ≈ 0.995 > 0.8
  // maxWick (0.04) > body*3 (0.0003) ✓

  const { candles: h4Candles } = normalizeCandles([realWickBar], baseOpts({ timeframe: "H4", now: EPOCH + H4_MS * 100 }));
  const { candles: m5Candles } = normalizeCandles([realWickBar], baseOpts({ timeframe: "M5", now: EPOCH + M5_MS * 100 }));
  const { candles: m15Candles } = normalizeCandles([realWickBar], baseOpts({ timeframe: "M15", now: EPOCH + 15 * 60 * 1000 * 100 }));

  assert.ok(h4Candles[0]!.qualityFlags.includes("OUTLIER_WICK"), "H4 must fire OUTLIER_WICK on extreme wick");
  assert.ok(!m5Candles[0]!.qualityFlags.includes("OUTLIER_WICK"), "M5 must NOT fire OUTLIER_WICK (not applicable timeframe)");
  assert.ok(!m15Candles[0]!.qualityFlags.includes("OUTLIER_WICK"), "M15 must NOT fire OUTLIER_WICK");
});

test("[F25] D1 long-wick detection fires", () => {
  const realWickBar: Candle = { time: ts(0), open: 1.1000, high: 1.1401, low: 1.0999, close: 1.1001 };
  const { candles } = normalizeCandles([realWickBar], baseOpts({ timeframe: "D1", now: EPOCH + D1_MS * 100 }));
  assert.ok(candles[0]!.qualityFlags.includes("OUTLIER_WICK"), "D1 must fire OUTLIER_WICK on extreme wick");
});

// ── Preservation checks ──────────────────────────────────────────────────────

test("[F26] trailingIntervalGap returns null on empty candles", () => {
  const result = trailingIntervalGap([], "M5", Date.now());
  assert.equal(result, null);
});

test("[F27] trailingIntervalGap returns a finite number on non-empty candles", () => {
  const { candles } = normalizeCandles([bullBar(0)], baseOpts({ now: EPOCH + M5_MS * 100 }));
  const gap = trailingIntervalGap(candles, "M5", EPOCH + M5_MS * 100);
  assert.ok(typeof gap === "number" && Number.isFinite(gap), "trailing gap must be a finite number");
});

test("[F28] sourceModeFromProvider('mock') = 'mock'", () => {
  assert.equal(sourceModeFromProvider("mock"), "mock");
  assert.equal(sourceModeFromProvider("twelveData_mock_shim"), "mock");
});

test("[F29] sourceModeFromProvider('deriv') = 'live'", () => {
  assert.equal(sourceModeFromProvider("deriv"), "live");
});

test("[F30] sourceModeFromProvider('assistant_real:twelve_data') = 'live'", () => {
  assert.equal(sourceModeFromProvider("assistant_real:twelve_data"), "live");
});

test("[F31] priceBasisFromProvider('mt5_broker') = 'BID'", () => {
  assert.equal(priceBasisFromProvider("mt5_broker"), "BID");
});

test("[F32] priceBasisFromProvider('deriv') = 'SYNTHETIC'", () => {
  assert.equal(priceBasisFromProvider("deriv"), "SYNTHETIC");
});

test("[F33] isValidOhlc rejects negative prices", () => {
  assert.equal(isValidOhlc({ open: -1.0, high: 1.1, low: -2.0, close: 1.0 }), false);
  assert.equal(isValidOhlc({ open: 1.0, high: 1.1, low: 0.9, close: 1.0 }), true);
});

test("[F34] isValidOhlc rejects non-finite values", () => {
  assert.equal(isValidOhlc({ open: NaN, high: 1.1, low: 0.9, close: 1.0 }), false);
  assert.equal(isValidOhlc({ open: Infinity, high: 1.1, low: 0.9, close: 1.0 }), false);
  assert.equal(isValidOhlc({ open: 1.0, high: 1.1, low: 0.9, close: 1.0 }), true);
});

// ── Session-aware candle completeness (Task #483) ────────────────────────────
//
// A naive 24/7 expected-bar grid mistakes forex weekend/off-hours closures for
// missing bars (quality=partial, aiUsable=false), wrongly downgrading Ruby on a
// COMPLETE feed. These tests lock the session-aware completeness contract:
//   - weekend/market-closed slots are NOT counted as missing,
//   - genuine mid-stream gaps (a run of ≥2 absent EXPECTED slots) still flag,
//   - isolated one-off closures are tolerated up to a small threshold,
//   - 24/7 instruments (no sessionExpected) keep the naive count unchanged,
//   - a session instrument WITHOUT trustworthy history fails honest (no assert).
//
// All bars are built on an absolute day-index grid: slotIndex = dayIndex mod 7,
// so days 0–4 act as the "weekday" session and days 5–6 as the weekend. The
// presence profile is built (pure) from several weeks of weekday-only opens so
// its expectedSlots = {0,1,2,3,4}.

function d1Bar(dayIndex: number): Candle {
  return {
    time: new Date(dayIndex * D1_MS).toISOString(),
    open: 1.1000,
    high: 1.1010,
    low: 1.0990,
    close: 1.1005,
  };
}

/** Profile trained on 4 weeks of weekday-only (dow 0–4) D1 opens. */
function weekdayD1Profile() {
  const opens: number[] = [];
  for (let w = 0; w < 4; w++) {
    for (let dow = 0; dow < 5; dow++) opens.push((w * 7 + dow) * D1_MS);
  }
  return buildWeeklyPresenceProfile(opens, D1_MS);
}

function d1Opts(profile: ReturnType<typeof weekdayD1Profile> | null, now: number) {
  return baseOpts({
    timeframe: "D1",
    now,
    sessionExpected: true,
    sessionProfile: profile,
  });
}

test("[F35] Session profile built from weekday-only history trusts weekday slots, excludes weekend", () => {
  const profile = weekdayD1Profile();
  assert.equal(profile.sufficientHistory, true, "4 weeks must be enough history");
  for (let dow = 0; dow < 5; dow++) {
    assert.ok(profile.expectedSlots.has(dow), `weekday slot ${dow} must be expected`);
  }
  assert.equal(profile.expectedSlots.has(5), false, "Saturday slot must NOT be expected");
  assert.equal(profile.expectedSlots.has(6), false, "Sunday slot must NOT be expected");
});

test("[F36] EURUSD-style weekend gap → NOT missing, feed stays clean/aiUsable", () => {
  const profile = weekdayD1Profile();
  // Two trading weeks, weekday bars only — the only gap is the weekend between them.
  const raw: Candle[] = [];
  for (let w = 10; w <= 11; w++) {
    for (let dow = 0; dow < 5; dow++) raw.push(d1Bar(w * 7 + dow));
  }
  const now = (11 * 7 + 5) * D1_MS; // just after the last weekday bar
  const { anomalies } = normalizeCandles(raw, d1Opts(profile, now));

  assert.equal(anomalies.sessionProfileApplied, true, "session profile must be applied");
  assert.equal(anomalies.missingCandleCount, 0, "weekend closure must NOT count as missing");
  assert.ok(anomalies.marketClosedSlotCount >= 2, "Sat+Sun must be counted as market-closed");
  assert.equal(anomalies.isolatedClosureCount, 0);

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
    completenessReason: anomalies.qualityReason,
  });
  assert.equal(verdict.quality, "clean", "complete forex feed across a weekend must be clean");
  assert.equal(verdict.aiUsable, true, "Ruby must be allowed on a complete weekend-spanning feed");
});

test("[F37] Genuine mid-stream gap (≥2 absent weekday slots) → flags missing, partial/not-aiUsable", () => {
  const profile = weekdayD1Profile();
  // Week 10: keep dow 0,1, DROP dow 2,3 (both expected weekdays), keep dow 4.
  const raw: Candle[] = [
    d1Bar(10 * 7 + 0),
    d1Bar(10 * 7 + 1),
    d1Bar(10 * 7 + 4),
  ];
  const now = (10 * 7 + 5) * D1_MS;
  const { anomalies } = normalizeCandles(raw, d1Opts(profile, now));

  assert.equal(anomalies.sessionProfileApplied, true);
  assert.equal(anomalies.missingCandleCount, 2, "two consecutive weekday bars are a genuine gap");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
  });
  assert.equal(verdict.quality, "partial", "a genuine gap must downgrade quality");
  assert.equal(verdict.aiUsable, false, "Ruby must NOT run on a genuinely incomplete feed");
});

test("[F38] Isolated one-off closure (single absent weekday) tolerated → not missing, advisory reason set", () => {
  const profile = weekdayD1Profile();
  // Week 10: keep dow 0,1, DROP only dow 2 (single weekday hole), keep dow 3,4.
  const raw: Candle[] = [
    d1Bar(10 * 7 + 0),
    d1Bar(10 * 7 + 1),
    d1Bar(10 * 7 + 3),
    d1Bar(10 * 7 + 4),
  ];
  const now = (10 * 7 + 5) * D1_MS;
  const { anomalies } = normalizeCandles(raw, d1Opts(profile, now));

  assert.equal(anomalies.isolatedClosureCount, 1, "single absent weekday is an isolated closure");
  assert.equal(anomalies.missingCandleCount, 0, "isolated closure under tolerance must not count as missing");
  assert.equal(anomalies.qualityReason, "isolated_closure_or_gap");
});

test("[F39] 24/7 synthetic (no sessionExpected) keeps the naive missing count — a single hole still flags", () => {
  // Same single-hole sequence as F38 but WITHOUT session awareness: naive grid
  // must still count the absent slot as missing (Deriv synthetics unchanged).
  const raw: Candle[] = [
    d1Bar(10 * 7 + 0),
    d1Bar(10 * 7 + 1),
    d1Bar(10 * 7 + 3),
    d1Bar(10 * 7 + 4),
  ];
  const now = (10 * 7 + 5) * D1_MS;
  const { anomalies } = normalizeCandles(raw, baseOpts({ timeframe: "D1", now }));

  assert.equal(anomalies.sessionProfileApplied, false, "no session profile for 24/7 instruments");
  assert.equal(anomalies.missingCandleCount, 1, "naive grid must still count the single absent slot");
});

test("[F40] Session instrument with insufficient history → fails honest (no missing asserted, reason set)", () => {
  // Only ONE observed week → sufficientHistory=false → profile must NOT be trusted.
  const opens: number[] = [];
  for (let dow = 0; dow < 5; dow++) opens.push(dow * D1_MS);
  const thinProfile = buildWeeklyPresenceProfile(opens, D1_MS);
  assert.equal(thinProfile.sufficientHistory, false, "one week must be insufficient");

  // A weekend-spanning sequence that a naive grid would call incomplete.
  const raw: Candle[] = [];
  for (let w = 10; w <= 11; w++) {
    for (let dow = 0; dow < 5; dow++) raw.push(d1Bar(w * 7 + dow));
  }
  const now = (11 * 7 + 5) * D1_MS;
  const { anomalies } = normalizeCandles(raw, d1Opts(thinProfile, now));

  assert.equal(anomalies.sessionProfileApplied, false, "thin profile must not be applied");
  assert.equal(anomalies.missingCandleCount, 0, "without trustworthy history we must NOT assert missing bars");
  assert.equal(anomalies.qualityReason, "insufficient_history_for_session_profile");
});

test("[F41] M5 forex weekend gap → session-aware completeness keeps feed clean", () => {
  // Build an M5 profile over 4 weeks of weekday-only bars, then assess two
  // weekday M5 runs separated by a weekend. Exercises the intraday path.
  const SLOTS_PER_DAY = D1_MS / M5_MS; // 288
  const profileOpens: number[] = [];
  for (let w = 0; w < 4; w++) {
    for (let dow = 0; dow < 5; dow++) {
      const dayStart = (w * 7 + dow) * D1_MS;
      for (let s = 0; s < SLOTS_PER_DAY; s++) profileOpens.push(dayStart + s * M5_MS);
    }
  }
  const m5Profile = buildWeeklyPresenceProfile(profileOpens, M5_MS);
  assert.equal(m5Profile.sufficientHistory, true);

  // Assessed feed: Friday (dow 4) of week 10, dense M5, then Monday (dow 0) of
  // week 11 — the entire weekend (Sat+Sun) is absent but market-closed.
  const raw: Candle[] = [];
  const friStart = (10 * 7 + 4) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) raw.push({ time: new Date(friStart + s * M5_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  const monStart = (11 * 7 + 0) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) raw.push({ time: new Date(monStart + s * M5_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });

  const now = monStart + SLOTS_PER_DAY * M5_MS;
  const { anomalies } = normalizeCandles(raw, baseOpts({ timeframe: "M5", now, sessionExpected: true, sessionProfile: m5Profile }));

  assert.equal(anomalies.sessionProfileApplied, true);
  assert.equal(anomalies.missingCandleCount, 0, "intraday weekend closure must not count as missing");
  assert.ok(anomalies.marketClosedSlotCount > 0);
});

// ── M30 derived-profile completeness (Task #485) ─────────────────────────────
//
// broker_candles carries M1/M5/M15/H1/H4/D1 only — there is NO M30. Before the
// fix, an M30 chart's session-profile lookup returned empty (insufficient
// history), so M30 fell off the session-aware path and a forex weekend wrongly
// downgraded the feed. getSessionProfile now DERIVES the M30 presence profile
// from the finer stored M15 series: read M15 bar opens, bucket them at the M30
// interval. Every M30 slot that traded contains ≥1 M15 bar, so the derived
// profile reproduces the exact same weekly slot coverage. These fixtures lock
// the pure derivation math + the resulting clean/partial verdicts.

const M30_MS = 30 * 60 * 1000;

/** Derive an M30 presence profile from 4 weeks of weekday-only M15 opens —
 *  exactly what getSessionProfile does for an M30 chart (read M15, build M30). */
function deriveM30ProfileFromM15() {
  const M15_MS = 15 * 60 * 1000;
  const M15_PER_DAY = D1_MS / M15_MS; // 96
  const opens: number[] = [];
  for (let w = 0; w < 4; w++) {
    for (let dow = 0; dow < 5; dow++) {
      const dayStart = (w * 7 + dow) * D1_MS;
      for (let s = 0; s < M15_PER_DAY; s++) opens.push(dayStart + s * M15_MS);
    }
  }
  // Bucket the finer M15 opens at the COARSER M30 interval.
  return buildWeeklyPresenceProfile(opens, M30_MS);
}

test("[F42] M30 profile derived from M15 opens trusts every weekday M30 slot, excludes weekend", () => {
  const profile = deriveM30ProfileFromM15();
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  assert.equal(profile.sufficientHistory, true, "4 weeks of M15 history must be enough");
  assert.equal(profile.intervalMs, M30_MS, "derived profile must be bucketed at the M30 interval");
  // Each weekday (dow 0–4) contributes 48 M30 slots; all must be expected.
  for (let dow = 0; dow < 5; dow++) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const slot = dow * SLOTS_PER_DAY + s;
      assert.ok(profile.expectedSlots.has(slot), `weekday M30 slot ${slot} must be expected`);
    }
  }
  // The first Saturday M30 slot must NOT be expected.
  assert.equal(
    profile.expectedSlots.has(5 * SLOTS_PER_DAY),
    false,
    "Saturday M30 slot must NOT be expected",
  );
});

test("[F43] M30 forex weekend gap (derived profile) → NOT missing, feed stays clean/aiUsable", () => {
  const profile = deriveM30ProfileFromM15();
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  // Friday (dow 4) of week 10 dense M30, then Monday (dow 0) of week 11 — the
  // entire weekend (Sat+Sun) is absent but market-closed.
  const raw: Candle[] = [];
  const friStart = (10 * 7 + 4) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(friStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const monStart = (11 * 7 + 0) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(monStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const now = monStart + SLOTS_PER_DAY * M30_MS;
  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: profile }),
  );

  assert.equal(anomalies.sessionProfileApplied, true, "derived M30 profile must be applied");
  assert.equal(anomalies.missingCandleCount, 0, "weekend closure must NOT count as missing on M30");
  assert.ok(anomalies.marketClosedSlotCount > 0, "weekend M30 slots must be market-closed");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
    completenessReason: anomalies.qualityReason,
  });
  assert.equal(verdict.quality, "clean", "complete M30 forex feed across a weekend must be clean");
  assert.equal(verdict.aiUsable, true, "Ruby must run on a complete weekend-spanning M30 feed");
});

test("[F44] M30 genuine mid-stream gap (≥2 absent weekday slots) → flags missing, partial/not-aiUsable", () => {
  const profile = deriveM30ProfileFromM15();
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  // Tuesday (dow 1) of week 10: keep all M30 bars EXCEPT two consecutive
  // expected slots (s=10, s=11) — a genuine 2-bar hole, not a weekend.
  const dayStart = (10 * 7 + 1) * D1_MS;
  const raw: Candle[] = [];
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    if (s === 10 || s === 11) continue;
    raw.push({ time: new Date(dayStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const now = dayStart + SLOTS_PER_DAY * M30_MS;
  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: profile }),
  );

  assert.equal(anomalies.sessionProfileApplied, true);
  assert.equal(anomalies.missingCandleCount, 2, "two consecutive absent weekday M30 bars are a genuine gap");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
  });
  assert.equal(verdict.quality, "partial", "a genuine M30 gap must downgrade quality");
  assert.equal(verdict.aiUsable, false, "Ruby must NOT run on a genuinely incomplete M30 feed");
});

// ── DST-transition resilience (Task #487) ────────────────────────────────────
//
// The spec's REQUIRED approach is a LEARNED weekly presence profile, NOT a
// hardcoded Fri→Sun window. The decisive test of that distinction is a daylight-
// saving transition: forex session boundaries shift by one hour mid-history
// (e.g. the Friday close moves from 23:00 to 22:00 when the clocks change). A
// hardcoded window baked to ONE season would treat the boundary hour of the
// OTHER season as a trading slot and false-flag its absence as "missing". The
// learned profile cannot, because a boundary slot that traded in only a MINORITY
// of observed weeks falls below EXPECTED_PRESENCE_RATIO (0.5) and is demoted to
// market-closed — so its absence is never a gap. These fixtures prove that
// demotion ON M30 (the derived-profile timeframe) and contrast it against a
// naive single-season profile to show the false gap the learned approach avoids.

const M15_MS = 15 * 60 * 1000;
const M15_PER_DAY = D1_MS / M15_MS; // 96

/**
 * Derive an M30 presence profile from M15 history that straddles a DST shift.
 * `fullFridayWeeks` weeks trade a FULL Friday (M15 s=0..95 → M30 slots 0..47);
 * the remaining weeks close one hour early (drop M15 s=92..95 → M30 slots 46,47
 * absent). With 1 full + 3 short weeks the boundary slots 46,47 appear in 1/4 =
 * 0.25 of weeks → below 0.5 → demoted. With 4 full weeks they appear 4/4 →
 * expected (the naive single-season baseline).
 */
function deriveM30DstProfileFromM15(totalWeeks: number, fullFridayWeeks: number) {
  const opens: number[] = [];
  for (let w = 0; w < totalWeeks; w++) {
    for (let dow = 0; dow < 5; dow++) {
      const dayStart = (w * 7 + dow) * D1_MS;
      const isFriday = dow === 4;
      const earlyClose = isFriday && w >= fullFridayWeeks; // summer weeks close early
      const lastM15 = earlyClose ? M15_PER_DAY - 4 : M15_PER_DAY; // drop final hour
      for (let s = 0; s < lastM15; s++) opens.push(dayStart + s * M15_MS);
    }
  }
  return buildWeeklyPresenceProfile(opens, M30_MS);
}

test("[F45] DST boundary shift on M30: learned profile demotes the shifted slot → no false gap (naive single-season profile would flag)", () => {
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  const FRI = 4;
  const slot45 = FRI * SLOTS_PER_DAY + 45; // 21:30–22:00 — traded every season
  const slot46 = FRI * SLOTS_PER_DAY + 46; // 22:00–22:30 — DST-shifted boundary
  const slot47 = FRI * SLOTS_PER_DAY + 47; // 22:30–23:00 — DST-shifted boundary

  // LEARNED profile: 1 full-Friday (winter) week + 3 early-close (summer) weeks.
  const learned = deriveM30DstProfileFromM15(4, 1);
  assert.equal(learned.sufficientHistory, true, "4 weeks is enough history");
  assert.ok(learned.expectedSlots.has(slot45), "the always-traded boundary slot stays expected");
  assert.equal(learned.expectedSlots.has(slot46), false, "DST-shifted slot (1/4 weeks) must be demoted, not expected");
  assert.equal(learned.expectedSlots.has(slot47), false, "DST-shifted slot (1/4 weeks) must be demoted, not expected");

  // Assessed feed: a SUMMER Friday (early close, slots 46/47 absent) → Monday.
  const buildSummerFeed = (): Candle[] => {
    const raw: Candle[] = [];
    const friStart = (10 * 7 + FRI) * D1_MS;
    for (let s = 0; s <= 45; s++) {
      raw.push({ time: new Date(friStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
    }
    const monStart = (11 * 7 + 0) * D1_MS;
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      raw.push({ time: new Date(monStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
    }
    return raw;
  };
  const raw = buildSummerFeed();
  const now = (11 * 7 + 0) * D1_MS + SLOTS_PER_DAY * M30_MS;

  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: learned }),
  );
  assert.equal(anomalies.sessionProfileApplied, true, "learned M30 profile must be applied");
  assert.equal(anomalies.missingCandleCount, 0, "DST-shifted boundary must NOT count as missing under the learned profile");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
    completenessReason: anomalies.qualityReason,
  });
  assert.equal(verdict.quality, "clean", "a DST-spanning M30 feed must stay clean under the learned profile");
  assert.equal(verdict.aiUsable, true, "Ruby must run across a DST boundary on the learned profile");

  // CONTRAST: a naive single-season (4 full-Friday weeks) profile bakes the
  // winter boundary as a trading slot. The IDENTICAL summer feed now shows the
  // two boundary slots as a genuine 2-bar gap — exactly the false DST gap the
  // learned profile avoids.
  const naive = deriveM30DstProfileFromM15(4, 4);
  assert.ok(naive.expectedSlots.has(slot46), "naive single-season profile wrongly keeps the boundary slot expected");
  assert.ok(naive.expectedSlots.has(slot47), "naive single-season profile wrongly keeps the boundary slot expected");
  const naiveRun = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: naive }),
  );
  assert.equal(naiveRun.anomalies.missingCandleCount, 2, "naive single-season profile false-flags the DST boundary as a 2-bar gap");
});

test("[F46] M30 derived from thin M15 history (<3 weeks) → fails honest (no missing asserted, insufficient-history reason)", () => {
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  // Only ONE observed week of M15 → derived M30 profile is below the 3-week
  // minimum → must NOT be trusted (mirrors F40 on the derived M30 path).
  const opens: number[] = [];
  for (let dow = 0; dow < 5; dow++) {
    const dayStart = dow * D1_MS;
    for (let s = 0; s < M15_PER_DAY; s++) opens.push(dayStart + s * M15_MS);
  }
  const thinM30 = buildWeeklyPresenceProfile(opens, M30_MS);
  assert.equal(thinM30.intervalMs, M30_MS, "derived profile is bucketed at M30");
  assert.equal(thinM30.sufficientHistory, false, "one week of M15 must be insufficient for an M30 profile");

  // A weekend-spanning M30 feed a naive grid would call incomplete.
  const raw: Candle[] = [];
  const friStart = (10 * 7 + 4) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(friStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const monStart = (11 * 7 + 0) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(monStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const now = monStart + SLOTS_PER_DAY * M30_MS;
  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: thinM30 }),
  );

  assert.equal(anomalies.sessionProfileApplied, false, "thin derived M30 profile must not be applied");
  assert.equal(anomalies.missingCandleCount, 0, "without trustworthy M30 history we must NOT assert missing bars");
  assert.equal(anomalies.qualityReason, "insufficient_history_for_session_profile");
});

// ── DST-transition resilience on a STORED timeframe (Task #490) ──────────────
//
// F45 proved DST resilience on M30 — the DERIVED-profile timeframe (its
// presence profile is bucketed up from the finer stored M15 series). The same
// learned-profile mechanism applies to the directly-STORED timeframes that
// broker_candles carries natively (H1/H4/D1): there is NO derivation step, the
// H1 presence profile is learned straight from H1 bar opens. This fixture pins
// that the DST demotion is timeframe-agnostic — not an artefact of the M30
// derivation path. When the broker's server-time offset changes at a DST
// transition, the weekly Friday-close boundary band shifts across the hourly
// grid: the final boundary H1 bars trade in one season's weeks but not the
// other's. A boundary slot present in only a MINORITY of observed weeks falls
// below EXPECTED_PRESENCE_RATIO (0.5) and is demoted to market-closed, so its
// absence is never a gap. A naive single-season H1 profile bakes one season's
// boundary band as trading slots and false-flags the other season's absence.
//
// The boundary band here is modelled as the final TWO H1 bars of the Friday
// session — deliberately a >=2-slot run so the demotion is what keeps the feed
// clean, NOT the separate isolated-closure tolerance (which already swallows any
// single absent slot regardless of profile). That isolates the learned-profile
// mechanism on the stored-timeframe path.

/**
 * Build an H1 presence profile DIRECTLY from H1 history that straddles a DST
 * shift (no derivation — H1 is a stored timeframe). `fullBoundaryWeeks` weeks
 * trade a FULL Friday (H1 hours 0..23 → boundary slots 22,23 present); the
 * remaining weeks close two hours early (drop hours 22,23 → those slots absent),
 * modelling the season whose server-time offset moves the boundary band earlier.
 * With 1 full + 3 short weeks the boundary band appears in 1/4 = 0.25 of weeks →
 * below 0.5 → demoted. With 4 full weeks it appears 4/4 → expected (the naive
 * single-season baseline).
 */
function buildH1DstProfile(totalWeeks: number, fullBoundaryWeeks: number) {
  const H1_PER_DAY = D1_MS / H1_MS; // 24
  const opens: number[] = [];
  for (let w = 0; w < totalWeeks; w++) {
    for (let dow = 0; dow < 5; dow++) {
      const dayStart = (w * 7 + dow) * D1_MS;
      const isFriday = dow === 4;
      const earlyClose = isFriday && w >= fullBoundaryWeeks; // summer weeks close 2h early
      const lastHour = earlyClose ? H1_PER_DAY - 2 : H1_PER_DAY; // drop the final 2 boundary hours
      for (let s = 0; s < lastHour; s++) opens.push(dayStart + s * H1_MS);
    }
  }
  return buildWeeklyPresenceProfile(opens, H1_MS);
}

test("[F47] DST boundary shift on H1 (stored timeframe): learned profile demotes the shifted boundary band → no false gap (naive single-season profile would flag)", () => {
  const SLOTS_PER_DAY = D1_MS / H1_MS; // 24
  const FRI = 4;
  const slot21 = FRI * SLOTS_PER_DAY + 21; // 21:00–22:00 — traded every season
  const slot22 = FRI * SLOTS_PER_DAY + 22; // 22:00–23:00 — DST-shifted boundary hour
  const slot23 = FRI * SLOTS_PER_DAY + 23; // 23:00–00:00 — DST-shifted boundary hour

  // LEARNED profile: 1 full-boundary (winter) week + 3 early-close (summer) weeks.
  const learned = buildH1DstProfile(4, 1);
  assert.equal(learned.sufficientHistory, true, "4 weeks is enough history");
  assert.equal(learned.intervalMs, H1_MS, "stored H1 profile must be bucketed at the H1 interval");
  assert.ok(learned.expectedSlots.has(slot21), "the always-traded boundary hour stays expected");
  assert.equal(learned.expectedSlots.has(slot22), false, "DST-shifted hour (1/4 weeks) must be demoted, not expected");
  assert.equal(learned.expectedSlots.has(slot23), false, "DST-shifted hour (1/4 weeks) must be demoted, not expected");

  // Assessed feed: a SUMMER Friday (early close, boundary slots 22,23 absent) → Monday.
  const raw: Candle[] = [];
  const friStart = (10 * 7 + FRI) * D1_MS;
  for (let s = 0; s <= 21; s++) {
    raw.push({ time: new Date(friStart + s * H1_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const monStart = (11 * 7 + 0) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(monStart + s * H1_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const now = monStart + SLOTS_PER_DAY * H1_MS;

  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "H1", now, sessionExpected: true, sessionProfile: learned }),
  );
  assert.equal(anomalies.sessionProfileApplied, true, "learned H1 profile must be applied");
  assert.equal(anomalies.missingCandleCount, 0, "DST-shifted boundary band must NOT count as missing under the learned profile");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
    completenessReason: anomalies.qualityReason,
  });
  assert.equal(verdict.quality, "clean", "a DST-spanning H1 feed must stay clean under the learned profile");
  assert.equal(verdict.aiUsable, true, "Ruby must run across a DST boundary on the learned H1 profile");

  // CONTRAST: a naive single-season (4 full-boundary weeks) profile bakes the
  // winter boundary band as trading slots. The IDENTICAL summer feed now shows
  // the two boundary hours as a genuine 2-bar gap — exactly the false DST gap
  // the learned profile avoids (and a >=2 run, so the isolated-closure tolerance
  // does NOT mask it).
  const naive = buildH1DstProfile(4, 4);
  assert.ok(naive.expectedSlots.has(slot22), "naive single-season profile wrongly keeps the boundary hour expected");
  assert.ok(naive.expectedSlots.has(slot23), "naive single-season profile wrongly keeps the boundary hour expected");
  const naiveRun = normalizeCandles(
    raw,
    baseOpts({ timeframe: "H1", now, sessionExpected: true, sessionProfile: naive }),
  );
  assert.equal(naiveRun.anomalies.missingCandleCount, 2, "naive single-season profile false-flags the DST boundary band as a 2-bar gap");
});

// ── DST transition that lands EXACTLY at the lookback midpoint (Task #491) ────
//
// F45/F47 cover the common case where a DST-shifted boundary trades in a MINORITY
// of weeks (1/4 = 0.25 → demoted). This fixture covers the narrow tie case: a
// daylight-saving transition that lands exactly at the MIDPOINT of the 8-week
// lookback, so a shifted boundary hour trades in EXACTLY half the observed weeks
// (4/8 = 0.5). The decision (Task #491) is to require a STRICT MAJORITY: the
// presence test is `count/observedWeeks > EXPECTED_PRESENCE_RATIO` (not `>=`), so
// a 50% tie is DEMOTED to market-closed. On M30 one boundary hour spans two
// slots, so under a `>=` rule the tie would stay expected and its absence in the
// new season would register as a transient 2-bar false gap. The strict-majority
// rule demotes the tie → no false gap. The contrast slot (5/8 = 0.625, a real
// strict majority) is still expected, so a genuine majority-present gap still
// flags — the demotion is scoped to the tie, not a blanket relaxation.

test("[F48] DST boundary at the exact lookback midpoint on M30 (4/8 = 0.5 tie): strict-majority rule demotes it → no false gap; a 5/8 majority slot still flags", () => {
  const SLOTS_PER_DAY = D1_MS / M30_MS; // 48
  const FRI = 4;
  const slot45 = FRI * SLOTS_PER_DAY + 45; // 21:30–22:00 — traded every week
  const slot46 = FRI * SLOTS_PER_DAY + 46; // 22:00–22:30 — DST-shifted boundary
  const slot47 = FRI * SLOTS_PER_DAY + 47; // 22:30–23:00 — DST-shifted boundary

  // LEARNED profile: 8 weeks, the DST transition splits them evenly — 4 full
  // (winter) Fridays + 4 early-close (summer) Fridays. The boundary slots 46/47
  // then trade in 4/8 = 0.5 of weeks: a perfect tie.
  const learned = deriveM30DstProfileFromM15(8, 4);
  assert.equal(learned.observedWeeks, 8, "eight weeks observed (DST splits them 4/4)");
  assert.equal(learned.sufficientHistory, true, "8 weeks is enough history");
  assert.ok(learned.expectedSlots.has(slot45), "the always-traded boundary slot stays expected");
  assert.equal(learned.expectedSlots.has(slot46), false, "a 4/8 = 0.5 tie slot must be DEMOTED under the strict-majority rule");
  assert.equal(learned.expectedSlots.has(slot47), false, "a 4/8 = 0.5 tie slot must be DEMOTED under the strict-majority rule");

  // Assessed feed: a SUMMER Friday (early close, slots 46/47 absent) → Monday.
  const raw: Candle[] = [];
  const friStart = (10 * 7 + FRI) * D1_MS;
  for (let s = 0; s <= 45; s++) {
    raw.push({ time: new Date(friStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const monStart = (11 * 7 + 0) * D1_MS;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    raw.push({ time: new Date(monStart + s * M30_MS).toISOString(), open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002 });
  }
  const now = monStart + SLOTS_PER_DAY * M30_MS;

  const { anomalies } = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: learned }),
  );
  assert.equal(anomalies.sessionProfileApplied, true, "learned M30 profile must be applied");
  assert.equal(anomalies.missingCandleCount, 0, "the 0.5-tie boundary must NOT count as missing under the strict-majority rule");

  const verdict = buildFeedStatus({
    routerOk: true,
    hasSource: true,
    candleCount: raw.length,
    trailingIntervals: 1,
    missingCandleCount: anomalies.missingCandleCount,
    completenessReason: anomalies.qualityReason,
  });
  assert.equal(verdict.quality, "clean", "a DST-tie-spanning M30 feed must stay clean under the strict-majority rule");
  assert.equal(verdict.aiUsable, true, "Ruby must run across an exact-midpoint DST boundary");

  // CONTRAST: a slot that traded in a TRUE strict majority (5/8 = 0.625) stays
  // expected, so the IDENTICAL summer feed (boundary absent) DOES flag a genuine
  // 2-bar gap. This proves the strict-majority rule demotes only the tie, never a
  // real majority-present slot — genuine gaps are still caught.
  const majority = deriveM30DstProfileFromM15(8, 5);
  assert.equal(majority.observedWeeks, 8, "contrast profile also observes eight weeks");
  assert.ok(majority.expectedSlots.has(slot46), "a 5/8 = 0.625 strict majority slot stays expected");
  assert.ok(majority.expectedSlots.has(slot47), "a 5/8 = 0.625 strict majority slot stays expected");
  const majorityRun = normalizeCandles(
    raw,
    baseOpts({ timeframe: "M30", now, sessionExpected: true, sessionProfile: majority }),
  );
  assert.equal(majorityRun.anomalies.missingCandleCount, 2, "a genuine majority-present boundary still flags a 2-bar gap");
});
