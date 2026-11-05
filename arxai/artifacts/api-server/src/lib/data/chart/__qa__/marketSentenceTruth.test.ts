// Market sentences: "Risk looks normal" needs an actual read, and "Fresh read"
// needs a feed that is confirmed live — setup age in bars is not data freshness.
//
// Pure: the sentence engine over a hand-built state. No provider, DB or broker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarketSentences } from "../marketSentenceEngine.js";

type Input = Parameters<typeof buildMarketSentences>[0];

function state(over: {
  aiUsable?: boolean; stale?: boolean; quality?: string; isLive?: boolean;
  populated?: boolean; setup?: Record<string, unknown>;
} = {}): Input {
  const populated = over.populated ?? false;
  return {
    symbol: "EURUSD", displaySymbol: "EURUSD", timeframe: "M5", assetClass: "forex",
    aiUsable: over.aiUsable ?? true, stale: over.stale ?? false,
    truthState: { quality: over.quality ?? "clean", isLive: over.isLive ?? true, stale: over.stale ?? false, aiUsable: over.aiUsable ?? true },
    fastFlags: { momentumBurst: false },
    marketUnderstanding: {
      populated,
      trend: { populated, regime: "trending", direction: "bullish" },
      levels: { populated, levels: [], nearestSupport: null, nearestResistance: null },
      candleIntent: { populated, dominantPressure: "buyers" },
      timeframeAgreement: { populated, scalpOnlyWarning: false },
      evidence: { populated, evidenceFor: [], evidenceAgainst: [], contradictions: [] },
      readiness: { populated, score: populated ? 70 : null, quality: "B", vetoed: false, vetoReason: null },
    },
    setupState: { populated: false, stage: "no_setup", ageBars: null, decayScore: null, ...over.setup },
    decisionState: { populated, bias: "neutral", actionability: "wait", vetoed: false, quality: "B" },
  } as unknown as Input;
}

test("risk is not called normal when there is no read to assess", () => {
  const s = buildMarketSentences(state({ populated: false }));
  assert.match(s.market.text, /Not enough clean data/);
  assert.doesNotMatch(s.risk.text, /Risk looks normal/);
  assert.match(s.risk.text, /^Risk not assessed/);
  assert.equal(s.risk.tone, "neutral");
  // With a real read and nothing flagged, the all-clear line is unchanged.
  const read = buildMarketSentences(state({ populated: true }));
  assert.equal(read.risk.text, "Risk looks normal for this read — no major conflicts in the picture.");
  assert.equal(read.risk.tone, "info");
});

test("a young setup on a delayed or not-live feed is not a 'Fresh read'", () => {
  const setup = { populated: true, stage: "triggered", ageBars: 2, decayScore: 10 };
  for (const [name, over, word] of [
    ["delayed", { quality: "delayed", aiUsable: false }, /delayed/],
    ["not live (closed market)", { isLive: false }, /not live/],
  ] as const) {
    const s = buildMarketSentences(state({ ...over, setup, populated: true }));
    assert.doesNotMatch(s.signalFreshness.text, /Fresh read/, name);
    assert.match(s.signalFreshness.text, word, name);
    assert.match(s.signalFreshness.text, /2 bars old/, name);
    assert.notEqual(s.signalFreshness.tone, "info", name);
  }
  const live = buildMarketSentences(state({ setup, populated: true }));
  assert.equal(live.signalFreshness.text, "Fresh read — the setup is only 2 bars old.");
});
