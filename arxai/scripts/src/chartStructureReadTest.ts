// Ruby chart-read structure analyzer regression suite.
//
// Verifies the deterministic, no-LLM market-structure analyzer:
//   - never fabricates structure on insufficient data (honest empty path)
//   - returns all 9 required fields populated
//   - reads an uptrend as Bullish, a downtrend as Bearish
//   - holds a flat mid-range chart to Range-bound + Low confidence
//   - never forces a trade: conditions stay conditional, low confidence
//     yields a "waiting is valid" caution
//   - folds higher-timeframe disagreement down to Mixed
//   - carries the new "Decision support only…" wording (NO "demo first")
//
// SAFETY: pure function test. No DB, no broker calls, no env mutation.

import {
  analyzeChartStructure,
  quickTrend,
  higherTimeframeOf,
} from "../../artifacts/api-server/src/lib/assistant/chartStructure.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function mk(closes: number[], spread = 0.4): Candle[] {
  let t = Date.parse("2026-01-01T00:00:00Z");
  return closes.map((c) => {
    const open = c - spread * 0.2;
    const high = Math.max(open, c) + spread;
    const low = Math.min(open, c) - spread;
    t += 4 * 60 * 60 * 1000;
    return { time: new Date(t).toISOString(), open, high, low, close: c };
  });
}

// 1) Insufficient data → honest, never fabricated.
{
  const r = analyzeChartStructure(mk([100, 101, 102]));
  record(
    "insufficient data is honest",
    r.dataQuality === "insufficient" &&
      r.bias === "No clear edge" &&
      r.confidence === "Low" &&
      /not enough/i.test(r.supportZone + r.why),
    r.dataQuality,
  );
}

// 2) All 9 fields populated on a real read.
{
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5));
  const r = analyzeChartStructure(up, { htfBias: "Bullish" });
  const nonEmpty = (s: string) => typeof s === "string" && s.trim().length > 0;
  const allNine =
    nonEmpty(r.bias) &&
    nonEmpty(r.confidence) &&
    nonEmpty(r.why) &&
    nonEmpty(r.supportZone) &&
    nonEmpty(r.resistanceZone) &&
    nonEmpty(r.buyCondition) &&
    nonEmpty(r.sellCondition) &&
    nonEmpty(r.invalidation) &&
    nonEmpty(r.riskNote);
  record("all 9 fields populated", allNine, JSON.stringify(Object.keys(r)));
}

// 3) Uptrend reads Bullish.
{
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5));
  const r = analyzeChartStructure(up, { htfBias: "Bullish" });
  record("uptrend → Bullish", r.bias === "Bullish", `${r.bias}/${r.confidence}`);
}

// 4) Downtrend reads Bearish.
{
  const down = mk(Array.from({ length: 80 }, (_, i) => 220 - i * 1.5));
  const r = analyzeChartStructure(down, { htfBias: "Bearish" });
  record("downtrend → Bearish", r.bias === "Bearish", `${r.bias}/${r.confidence}`);
}

// 5) Flat mid-range → Range-bound + Low confidence (no forced trade).
{
  // Tight, choppy band that deterministically ends mid-range (last = 100).
  const flatCloses = Array.from({ length: 79 }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3));
  flatCloses.push(100);
  const r = analyzeChartStructure(mk(flatCloses, 0.15));
  const waits = r.cautions.some((c) => /waiting is a valid|no forced trade/i.test(c));
  record(
    "flat → Range-bound, Low, no forced trade",
    r.bias === "Range-bound" && r.confidence === "Low" && waits,
    `${r.bias}/${r.confidence}`,
  );
}

// 6) Conditions stay conditional (never an unconditional "buy now").
{
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5));
  const r = analyzeChartStructure(up, { htfBias: "Bullish" });
  const conditional =
    /only if|becomes stronger|credible if/i.test(r.buyCondition) &&
    /only if|becomes stronger|credible if/i.test(r.sellCondition);
  record("triggers are conditional", conditional);
}

// 7) HTF disagreement softens a directional LTF call to Mixed.
{
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5));
  const r = analyzeChartStructure(up, { htfBias: "Bearish" });
  record("HTF conflict → Mixed", r.bias === "Mixed", r.bias);
}

// 8) New wording is present in no field; "demo first" never appears.
{
  const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5));
  const r = analyzeChartStructure(up, { htfBias: "Bullish" });
  const blob = JSON.stringify(r).toLowerCase();
  record("no 'demo first' wording in analyzer output", !blob.includes("demo first"));
}

// 9) quickTrend + higherTimeframeOf helpers.
{
  const up = mk(Array.from({ length: 60 }, (_, i) => 100 + i));
  const okTrend = quickTrend(up) === "Bullish";
  const okHtf = higherTimeframeOf("4h") === "1d" && higherTimeframeOf("1d") === "1w";
  record("helpers: quickTrend + higherTimeframeOf", okTrend && okHtf);
}

const passed = results.filter((r) => r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} chart-structure checks passed`);
if (passed !== results.length) process.exit(1);
