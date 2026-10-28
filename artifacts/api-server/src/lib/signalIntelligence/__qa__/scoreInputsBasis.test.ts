// Owner screenshot 2026-10-27 (V75 1m, Deriv public data, no MT5 bridge, news
// calendar unavailable): "Trade quality Modest · 42/100". Six of the seven
// dimensions folded into that 42 were fixed defaults (entry 40, execution 50,
// risk base 50, news safety 70, timing 60, survivability base 50) — only
// direction was read from candles. This locks: the scorer reports which
// dimensions were defaults, the arithmetic is unchanged, and the band carries a
// PARTIAL basis so no surface may show "Modest" as an observed grade.
//
// Run:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/signalIntelligence/__qa__/scoreInputsBasis.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRubyMarketEdge,
  computeScores,
  unmeasuredScoreDimensions,
  type ScoringInput,
  type SignalCandle,
} from "@workspace/domain/signal-intelligence";

const NOW = Date.parse("2026-10-27T16:03:00Z");

// Up-trend with pullbacks so the structure reads HH/HL and pressure builds up.
function trendCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let p = 33000;
  for (let i = 0; i < n; i++) {
    const step = i % 5 === 4 ? -6 : 9;
    const open = p;
    const close = p + step;
    out.push({ open, high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close, volume: 0 });
    p = close;
  }
  return out;
}

const ownerBuilt = buildRubyMarketEdge({
  symbol: "R_75",
  displayName: "V75",
  timeframe: "M1",
  assetClass: "synthetic",
  candles: trendCandles(120),
  currentPrice: 33500,
  dataSource: "LIVE_FEED",
  scanner: null,
  scalp: null,
  execution: null,
  newsRiskLevel: null,
  previous: null,
  now: NOW,
});

function ownerInput(over: Partial<ScoringInput> = {}): ScoringInput {
  return {
    direction: "BUY",
    hasSufficientData: true,
    early: ownerBuilt.earlyTrend,
    fakeout: { ...ownerBuilt.fakeout, detected: false },
    scanner: null,
    scalp: null,
    execution: null,
    evidence: { for: [{ key: "structure_hh_hl", label: "Higher highs / higher lows", weight: 20 }], against: [], conflicts: [], meetsMinimum: false, netScore: 20 },
    late: { ...ownerBuilt.late, isLate: false, doNotChase: false, remainingRR: null, percentOfMoveComplete: null },
    newsRiskLevel: null,
    playbookWeight: 1,
    ...over,
  };
}

test("owner state: six of seven score inputs are reported as defaults", () => {
  const scores = computeScores(ownerInput());
  assert.deepEqual(scores.unmeasured, ["entry", "execution", "risk", "newsSafety", "timing", "survivability"]);
  // The defaults themselves (arithmetic unchanged by this fix).
  assert.equal(scores.execution, 50);
  assert.equal(scores.newsSafety, 70);
  assert.equal(scores.timing, 60);
});

test("the producer marks the band basis PARTIAL in the owner state (band value itself unchanged)", () => {
  assert.equal(ownerBuilt.confidenceBandBasis, "PARTIAL");
  assert.ok((ownerBuilt.scores.unmeasured ?? []).includes("execution"));
  assert.ok((ownerBuilt.scores.unmeasured ?? []).includes("newsSafety"));
});

test("every input observed → nothing unmeasured (FULL basis possible)", () => {
  const full = ownerInput({
    scanner: {
      bias: "bullish",
      recommendedAction: "BUY",
      confidenceScore: 70,
      entrySniperScore: 65,
      riskRewardRatio: 2,
      setupType: "Trend",
      entry: 33500,
      stopLoss: 33450,
      takeProfit: 33600,
    },
    scalp: {
      flameStage: "BUILDING",
      freshness: "FRESH",
      entryTiming: "CLEAN",
      chaseRisk: "LOW",
      runway: "OPEN",
      setupType: "Trend",
      htfContext: "aligned",
      scalpScore: 70,
      blind: false,
    },
    execution: { heartbeatAgeSeconds: 2, bridgeConnected: true },
    newsRiskLevel: "none",
    newsMeasured: true,
  });
  assert.deepEqual(unmeasuredScoreDimensions(full), []);
  assert.deepEqual(computeScores(full).unmeasured, []);
});

test("a news level the provider never answered for is a default; a blind scalp read is not timing", () => {
  const u = unmeasuredScoreDimensions(ownerInput({ newsRiskLevel: "none", newsMeasured: false }));
  assert.ok(u.includes("newsSafety"));
  const blindScalp = unmeasuredScoreDimensions(ownerInput({
    scalp: { flameStage: "NONE", freshness: "FRESH", entryTiming: "CLEAN", chaseRisk: "LOW", runway: "OPEN", setupType: "", htfContext: "", scalpScore: 0, blind: true },
  }));
  assert.ok(blindScalp.includes("timing"));
  assert.ok(blindScalp.includes("entry"));
});

test("unmeasured flags never change a score (label-only)", () => {
  const a = computeScores(ownerInput({ newsRiskLevel: "none", newsMeasured: false }));
  const b = computeScores(ownerInput({ newsRiskLevel: "none", newsMeasured: true }));
  const strip = ({ unmeasured: _u, ...rest }: typeof a) => rest;
  assert.deepEqual(strip(a), strip(b));
});

test("insufficient/neutral branch: only the non-zero defaults are reported", () => {
  const s = computeScores(ownerInput({ direction: "NEUTRAL" }));
  assert.equal(s.overall, 0);
  assert.deepEqual(s.unmeasured, ["execution", "newsSafety"]);
});
