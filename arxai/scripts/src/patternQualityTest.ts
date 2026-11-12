// Test: chart-pattern detection quality (lib/domain chart-patterns/patternEngine.ts).
//
// Claims (docs/PATTERN_DETECTION_QUALITY.md):
//   1. Every pattern planted as a textbook instance is found with the right id,
//      bias and status, its confirmation level within 0.25 ATR of the planted one.
//   2. The same paths with the defining feature broken are NOT named.
//   3. On every 150-bar window of the real-markets fixture no pattern has
//      disordered levels, a status that disagrees with the displayed levels, or
//      a key point outside the window.
//   4. Shifting every price by a power of ten changes nothing but the scale.
//   5. No pattern's drawn target is reached more (or less) often than a
//      driftless price would reach it: pinned, so a future claim of an edge must
//      change this test on purpose.
//   6. The doc is exactly what the code measures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectChartPatterns, quoteDecimals, type ChartPatternCandle } from "@workspace/domain/chart-patterns";
import { PATTERN_LIBRARY } from "@workspace/domain/market";
import { runPatternQuality, renderPatternQualityMarkdown } from "./research/patternQualityResearch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "..", "docs", "PATTERN_DETECTION_QUALITY.md");
/** Pinned from the one run on the pinned fixture and seeds. Change only on purpose. */
const PINNED_RESULT_HASH = "6a21b46f9949f9f206fd7d0d75a481a0db275b172c81349518c075f722e3b17d";

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };
const k = (o: number, h: number, l: number, c: number): ChartPatternCandle => ({ open: o, high: h, low: l, close: c, isComplete: true, isForming: false });

t("quote precision is the quote's own: 3-decimal prices round to 3 decimals at any magnitude", () => {
  const q = (x: number) => Number(x.toFixed(3));
  const bars = Array.from({ length: 30 }, (_, i) => k(q(65.191 + i * 0.001), q(65.2 + i * 0.001), 65.18, q(65.192 + i * 0.001)));
  assert.equal(quoteDecimals(bars), 3);
  assert.equal(quoteDecimals(bars.map((b) => ({ ...b, open: 1.08451, close: 1.08452, high: 1.08463, low: 1.0844 }))), 5);
  // An all-integer window falls back to the magnitude default.
  assert.equal(quoteDecimals(bars.map((b) => ({ ...b, open: 43250, close: 43251, high: 43260, low: 43240 }))), 1);
});

t("every catalogued detector id is in the pattern library, so the spec the doc checks against exists", () => {
  const ids = new Set(PATTERN_LIBRARY.map((e) => e.id));
  for (const id of ["head_and_shoulders", "inverse_head_and_shoulders", "double_top", "double_bottom", "bull_flag", "bear_flag",
    "liquidity_sweep_high", "liquidity_sweep_low", "breakout_retest_up", "breakout_retest_down", "bullish_engulfing", "bearish_engulfing",
    "bullish_pin_bar", "bearish_pin_bar", "scalp_flare_up", "scalp_flare_down"]) assert.ok(ids.has(id), id);
});

t("a liquidity sweep's target is the NEAREST prior swing below the close (the library's spec), not the window's extreme", () => {
  // Far low at 90 early, a nearer swing low at 96, prior high 100, then a sweep of 100 closing back at 99.
  const path = [95, 93, 91, 90, 91, 93, 95, 97, 99, 100, 99, 97, 96.5, 96, 96.5, 97, 97.5, 98, 98.5, 99, 99.2, 99.4];
  // Full wick on the close side, half on the open side, so a bar opening at a turn never ties it.
  const bars = path.map((c, i) => {
    const o = i ? path[i - 1]! : c;
    return c >= o ? k(o, c + 0.1, o - 0.05, c) : k(o, o + 0.05, c - 0.1, c);
  });
  bars.push(k(99.4, 100.8, 99.0, 99.1));
  const sweep = detectChartPatterns(bars).patterns.find((p) => p.id === "liquidity_sweep_high");
  assert.ok(sweep, "sweep not detected");
  assert.equal(sweep.levels.targets[0], 95.9, `target ${sweep.levels.targets[0]}`);
});

const r = runPatternQuality();

t("planted textbook patterns: every id recalled >= 95% with the right bias, status and level", () => {
  assert.equal(r.planted.length, 16);
  for (const x of r.planted) {
    assert.ok(x.recalled / x.trials >= 0.95, `${x.id}: ${x.recalled}/${x.trials} (wrong status ${x.wrongStatus}, level off ${x.levelOff}, missed ${x.missed})`);
    assert.ok(x.maxLevelErrorAtr <= 0.25, `${x.id}: worst level error ${x.maxLevelErrorAtr} ATR`);
  }
});

t("near misses: every id rejected >= 95% when its defining feature is broken", () => {
  for (const x of r.planted) assert.ok(x.rejected / x.trials >= 0.95, `${x.id}: ${x.falseFires} false fires (${x.nearMiss})`);
});

t("real bars: zero level-order, status or key-point violations, and every pattern seen", () => {
  assert.ok(r.windows > 350_000, `${r.windows} windows`);
  assert.equal(r.consistency.length, 16, r.consistency.map((x) => x.id).join(","));
  for (const x of r.consistency) {
    assert.equal(x.badLevels, 0, `${x.id} levels`);
    assert.equal(x.badStatus, 0, `${x.id} status`);
    assert.equal(x.badKeyPoints, 0, `${x.id} key points`);
  }
  // Flags reach a decision (they used to stay "forming" on every window).
  for (const id of ["bull_flag", "bear_flag"]) assert.ok((r.consistency.find((x) => x.id === id)!.status.confirmed ?? 0) > 100, id);
});

t("scale invariance: no window changes under a power-of-ten price shift", () => {
  assert.ok(r.scaleWindows > 30_000);
  assert.equal(r.scaleMismatches, 0, r.scaleExamples.join("\n"));
});

t("forward outcomes: no pattern beats (or trails) the driftless base rate after FDR, as the doc says", () => {
  assert.ok(r.familySize >= 30, `only ${r.familySize} tested cells`);
  const disc = r.outcomes.filter((o) => o.fdrRejected);
  assert.equal(disc.length, 0, disc.map((o) => o.key).join(","));
});

t("results reproduce the pinned run", () => {
  assert.equal(r.resultHash, PINNED_RESULT_HASH);
});

t("the doc is exactly what the code measures", () => {
  assert.equal(readFileSync(DOC, "utf8").split("\n## Reading these results")[0]!.trimEnd(), renderPatternQualityMarkdown(r).trimEnd());
});

console.log(`\n${passed} passed`);
