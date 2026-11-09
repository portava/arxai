// Chart engine level prices keep the instrument's precision (truth review,
// pass 2).
//
// Round 3 made level personality round levels at the instrument's precision
// (resolveChartPriceDecimals: declared precision widened by the bars' digits).
// Four engines still re-rounded prices by magnitude (decimalsFor: >= 1000 → 1
// dp, >= 100 → 2 dp, >= 1 → 4 dp): the decision reasoning and decision fork
// turned EURUSD support 1.08523 back into 1.0852 and XAUUSD 2400.55 into
// 2400.6, the setup invalidation and the trendline levels were computed at the
// same lossy precision, and prices in text dropped trailing zeros ("2400.5").
// Display / report only. Offline: no provider, DB or broker calls.
//
// Run: node --import tsx --test --test-force-exit \
//        src/lib/data/chart/__qa__/chartEnginePricePrecision.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedChartCandle } from "../candleNormalization.js";
import { computeSetupLifecycle } from "../engines/setupLifecycle.js";
import { computeDecisionReasoning } from "../engines/decisionReasoning.js";
import { computeDecisionFork } from "../engines/decisionFork.js";
import { detectTrendlines } from "../engines/trendlineEngine.js";
import { chartPriceDecimals } from "../engines/chartPriceDecimals.js";

const epoch = Date.parse("2026-10-20T00:00:00Z");

function decimalsIn(n: number): number {
  for (let d = 0; d <= 8; d++) if (Math.abs(n - Number(n.toFixed(d))) < 1e-9) return d;
  return 8;
}

function bar(symbol: string, i: number, o: number, h: number, l: number, c: number): NormalizedChartCandle {
  return {
    symbol, displaySymbol: symbol, timeframe: "M5",
    openTime: new Date(epoch + i * 300_000).toISOString(),
    closeTime: new Date(epoch + (i + 1) * 300_000).toISOString(),
    open: o, high: h, low: l, close: c, volume: 0, tickVolume: null,
    source: "test", sourceMode: "live", priceBasis: "MID", providerSymbol: symbol, brokerSymbol: null,
    isComplete: true, isFinal: true, isForming: false, receivedAt: new Date(epoch + i * 300_000).toISOString(),
    qualityFlags: [],
  } as unknown as NormalizedChartCandle;
}

/** A rising channel quoted at `dp` decimals: swing lows at phase 0, highs at phase 3. */
function risingChannel(symbol: string, base: number, step: number, amp: number, dp: number, n = 42): NormalizedChartCandle[] {
  const q = (v: number) => Number(v.toFixed(dp));
  const out: NormalizedChartCandle[] = [];
  for (let i = 0; i < n; i++) {
    const phase = i % 6;
    const osc = (1 - Math.cos((2 * Math.PI * phase) / 6)) / 2;
    const mid = base + step * i + amp * osc;
    const w = amp / 20;
    out.push(bar(symbol, i, q(mid), q(mid + w), q(mid - w), q(mid)));
  }
  return out;
}

/** Flat zig-zag bars quoted at `dp` decimals around `lo`..`hi`. */
function zigzag(symbol: string, lo: number, hi: number, dp: number, bars = 40): NormalizedChartCandle[] {
  const q = (v: number) => Number(v.toFixed(dp));
  const out: NormalizedChartCandle[] = [];
  const range = hi - lo;
  for (let i = 0; i < bars; i++) {
    const phase = i % 10;
    const mid = lo + range * (phase < 5 ? phase / 5 : (10 - phase) / 5);
    out.push(bar(symbol, i, q(mid), q(mid + range / 20), q(mid - range / 20), q(mid)));
  }
  return out;
}

const level = (kind: "support" | "resistance", price: number) => ({
  kind, price, personality: "defended", touchCount: 3, rejectionCount: 2, breakCount: 0, retestCount: 0,
  strengthScore: 70, weaknessScore: 10, trapScore: 0, distancePct: kind === "support" ? -0.05 : 0.2,
});

test("shared helper: the instrument's declared precision from the symbol profile, widened by quoted digits", () => {
  assert.equal(chartPriceDecimals(zigzag("EURUSD", 1.08523, 1.08773, 5)), 5);
  assert.equal(chartPriceDecimals(zigzag("XAUUSD", 2400.55, 2410.55, 2)), 2);
  assert.equal(chartPriceDecimals(zigzag("XAUUSD", 2400.55, 2410.55, 2), "XAUUSD", null), 2, "declared null: observed digits");
});

test("decision reasoning prints EURUSD 1.08523 and XAUUSD 2400.50 at instrument precision", () => {
  const base = {
    trend: { populated: true, regime: "trending", direction: "bullish" },
    evidence: { populated: true, direction: "bullish", evidenceFor: [], evidenceAgainst: [], contradictions: [] },
    setup: { invalidationCondition: null, invalidationPrice: null },
  };
  const eur = computeDecisionReasoning({
    ...base,
    levels: { populated: true, nearestSupport: level("support", 1.08523), nearestResistance: level("resistance", 1.08773) },
    priceDecimals: 5,
  } as never);
  assert.equal(eur.improve[0]?.price, 1.08523, JSON.stringify(eur.improve));
  assert.match(eur.improve[0]?.text ?? "", /1\.08523\b/);
  assert.doesNotMatch(JSON.stringify(eur), /1\.0852[^3]/);

  const xau = computeDecisionReasoning({
    ...base,
    levels: { populated: true, nearestSupport: level("support", 2400.5), nearestResistance: level("resistance", 2410.55) },
    priceDecimals: 2,
  } as never);
  assert.match(xau.improve[0]?.text ?? "", /support 2400\.50\b/);
  assert.equal(xau.improve[1]?.price, 2410.55, "not 2410.6");
  assert.match(xau.improve[1]?.text ?? "", /2410\.55\b/);
});

test("decision fork maps branches around EURUSD 1.08523 and prints XAUUSD 2400.50", () => {
  const base = {
    trend: { populated: true, regime: "trending", direction: "bullish" },
    candleIntent: { populated: true, latestIntent: "pushing", dominantPressure: "buyers" },
    setup: { direction: "bullish", stage: "watchlist", invalidationCondition: null, invalidationPrice: null },
  };
  const eur = computeDecisionFork({
    ...base,
    levels: { populated: true, nearestSupport: level("support", 1.08523), nearestResistance: null },
    priceDecimals: 5,
  } as never);
  assert.equal(eur.pivotPrice, 1.08523);
  assert.ok(eur.branches.every((b) => b.price === 1.08523));
  assert.match(eur.note, /1\.08523\b/);

  const xau = computeDecisionFork({
    ...base,
    levels: { populated: true, nearestSupport: level("support", 2400.5), nearestResistance: null },
    priceDecimals: 2,
  } as never);
  assert.equal(xau.pivotPrice, 2400.5);
  assert.match(xau.note, /2400\.50\b/);
  assert.ok(xau.branches.some((b) => /2400\.50\b/.test(b.text)));
});

test("setup invalidation is computed and printed at instrument precision (EURUSD 5 dp)", () => {
  const closed = zigzag("EURUSD", 1.08523, 1.08773, 5);
  const setup = computeSetupLifecycle(
    closed, "M5",
    { populated: true, regime: "trending", direction: "bullish" } as never,
    { populated: true, nearestSupport: level("support", closed[closed.length - 1]!.close), nearestResistance: null } as never,
    { populated: true, latestIntent: "pushing", dominantPressure: "buyers" } as never,
  );
  assert.ok(setup.invalidationPrice != null, JSON.stringify(setup));
  assert.equal(decimalsIn(setup.invalidationPrice!), 5, `invalidation ${setup.invalidationPrice}`);
  assert.ok(setup.invalidationCondition?.includes(setup.invalidationPrice!.toFixed(5)), setup.invalidationCondition ?? "");
});

test("setup invalidation text keeps XAUUSD's two decimals", () => {
  const closed = zigzag("XAUUSD", 2400.55, 2410.55, 2);
  const setup = computeSetupLifecycle(
    closed, "M5",
    { populated: true, regime: "trending", direction: "bullish" } as never,
    { populated: true, nearestSupport: level("support", closed[closed.length - 1]!.close), nearestResistance: null } as never,
    { populated: true, latestIntent: "pushing", dominantPressure: "buyers" } as never,
  );
  assert.ok(setup.invalidationPrice != null);
  assert.ok(decimalsIn(setup.invalidationPrice!) <= 2);
  assert.match(setup.invalidationCondition ?? "", /below \d+\.\d{2} /);
  assert.ok(setup.invalidationCondition?.includes(setup.invalidationPrice!.toFixed(2)), setup.invalidationCondition ?? "");
});

test("trendline levels keep EURUSD's 5th decimal and XAUUSD's 2nd", () => {
  const eur = detectTrendlines(risingChannel("EURUSD", 1.08, 0.00004, 0.0004, 5));
  assert.ok(eur.trendlines.length > 0, "fixture draws a trendline");
  const eurLevels = eur.trendlines.flatMap((t) => [t.currentLevel, t.levels.confirmation, t.levels.invalidation]);
  assert.ok(eurLevels.some((v) => v != null && decimalsIn(v) === 5), `levels ${eurLevels.join(", ")}`);
  for (const v of eurLevels) if (v != null) assert.ok(decimalsIn(v) <= 5, `${v}`);

  const xau = detectTrendlines(risingChannel("XAUUSD", 2400, 0.4, 4, 2));
  assert.ok(xau.trendlines.length > 0, "fixture draws a trendline");
  const xauLevels = xau.trendlines.flatMap((t) => [t.currentLevel, t.levels.confirmation, t.levels.invalidation]);
  assert.ok(xauLevels.some((v) => v != null && decimalsIn(v) === 2), `levels ${xauLevels.join(", ")}`);
  for (const t of xau.trendlines) {
    for (const r of t.rationale) {
      for (const m of r.matchAll(/\b(\d{4,}\.\d+)\b/g)) assert.equal(m[1]!.split(".")[1]!.length, 2, `"${r}"`);
    }
  }
});

test("an explicit precision wins over the symbol profile (chart truth result)", () => {
  const candles = risingChannel("XAUUSD", 2400, 0.4, 4, 2);
  const all = (r: ReturnType<typeof detectTrendlines>) =>
    r.trendlines.flatMap((t) => [t.currentLevel, t.levels.confirmation, t.levels.invalidation, ...t.levels.targets])
      .filter((v): v is number => v != null);
  const profile = all(detectTrendlines(candles));
  assert.ok(profile.some((v) => decimalsIn(v) === 2), `profile levels ${profile.join(", ")}`);
  const whole = all(detectTrendlines(candles, { priceDecimals: 0 }));
  assert.ok(whole.length > 0);
  for (const v of whole) assert.equal(decimalsIn(v), 0, `explicit 0 dp: ${whole.join(", ")}`);
});
