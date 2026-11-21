// Test: the hour-of-week volatility range adopted for the structural forecast.
//
// Claims:
//   1. THE PUBLISHED RESULT IS THE MEASURED RESULT. Re-running the research on
//      the pinned real-markets fixture reproduces the pinned result hash, the
//      adoption verdict and the pooled lower bound, and
//      docs/STRUCTURAL_VOL_RANGE_RESULTS.md is exactly what the code renders.
//   2. WHAT SHIPS IS WHAT WAS MEASURED. The primary variant is scored through
//      the production functions (lib/domain/src/structural/volRange.ts), and the
//      production band equals the research formula to the last bit. The domain
//      copy of the seasonal fit gives the same factors as lib/risk fitSeasonal.
//   3. NO DIRECTION. The band is symmetric in logs: (1 + bull)(1 + bear) = 1 at
//      every bar, so it never leans up or down.
//   4. ONLY WHERE TESTED. Bar sizes the research did not test (M1, M5, M30, H4)
//      get no profile and keep the 120-bar band.
//
// Reads the pinned fixture only. No DB, no network, no broker, no clock.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fitSeasonal, parkinsonVar } from "@workspace/risk";
import { fitVolRangeProfile, seasonalBandAt, seasonalFactors, type StructuralBar } from "@workspace/domain/structural";
import { loadVerifiedMarketsFixture } from "./research/marketsHistoryFixture.js";
import { TIMEFRAME_SECONDS } from "./research/intradayHistoryFixture.js";
import { renderMarkdown, runStructuralVolRangeResearch } from "./research/structuralVolRangeResearch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const DOC = join(HERE, "..", "..", "docs", "STRUCTURAL_VOL_RANGE_RESULTS.md");

/** Pinned from the one research run on the pinned fixture. Change only on purpose. */
const PINNED_RESULT_HASH = "213e9c0f1fef0e8f89f6ad69a4488c31aff8a4de1e0a9e5e1bd74f5b649c9188";
const PINNED_ADOPTED = true;
const PINNED_SERIES = 28;
const PINNED_POOLED_N = 3633;

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

const result = runStructuralVolRangeResearch(FIXTURES);

t("the research reproduces the pinned result", () => {
  assert.equal(result.resultHash, PINNED_RESULT_HASH);
  assert.equal(result.adopted, PINNED_ADOPTED);
  assert.equal(result.series, PINNED_SERIES);
  assert.equal(result.summary[result.primary].n, PINNED_POOLED_N);
  assert.equal(result.primary, "seasonal");
});

t("adoption follows the pre-registered rule: pooled lower bound > 0", () => {
  assert.equal(result.adopted, result.summary.seasonal.lowerGain > 0);
  assert.ok(result.summary.seasonal.lowerGain > 0 && result.summary.seasonal.meanGain > result.summary.seasonal.lowerGain);
});

t("the results doc is exactly what the code renders", () => {
  assert.equal(readFileSync(DOC, "utf8").trimEnd(), renderMarkdown(result).trimEnd());
});

t("the production band is the measured band", () => {
  assert.equal(result.maxBandDiff, 0);
});

const { instruments } = loadVerifiedMarketsFixture(FIXTURES);
const toStructural = (inst: (typeof instruments)[number]): StructuralBar[] => {
  const step = TIMEFRAME_SECONDS[inst.spec.timeframe] * 1000;
  return inst.bars.map((b, i) => { const t0 = Date.parse(inst.dates[i]!); return { openTime: t0, closeTime: t0 + step, open: b.open, high: b.high, low: b.low, close: b.close, isFinal: true }; });
};

t("the domain seasonal fit equals lib/risk fitSeasonal on every series", () => {
  for (const inst of instruments) {
    const bars = inst.bars.map((b, i) => ({ t: Date.parse(inst.dates[i]!), high: b.high, low: b.low, close: b.close }));
    const v = bars.map(parkinsonVar);
    const end = Math.floor(bars.length * 0.4);
    assert.deepEqual(seasonalFactors(bars.map(b => b.t), v, end), Array.from(fitSeasonal(bars, v, end).factor), `${inst.spec.symbol} ${inst.spec.timeframe}`);
  }
});

t("the band is symmetric in logs: no direction", () => {
  const inst = instruments.find(i => i.spec.timeframe === "M15")!;
  const bars = toStructural(inst);
  const profile = fitVolRangeProfile(bars, Math.floor(bars.length / 2), 900_000)!;
  const band = seasonalBandAt(bars, profile, 60)!;
  assert.equal(band.bull.length, 60);
  band.bull.forEach((up, j) => {
    assert.ok(up > 0 && band.bear[j]! < 0);
    assert.ok(Math.abs((1 + up) * (1 + band.bear[j]!) - 1) < 1e-12);
  });
});

t("untested bar sizes get no profile and keep the 120-bar band", () => {
  const bars = toStructural(instruments[0]!);
  for (const step of [60_000, 300_000, 1_800_000, 14_400_000]) assert.equal(fitVolRangeProfile(bars, 1000, step), null, `step ${step}`);
  assert.ok(fitVolRangeProfile(bars, 1000, 900_000));
  assert.ok(fitVolRangeProfile(bars, 1000, 3_600_000));
});

console.log(`\n${passed} passed`);
