import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionCandidate, DecisionCandidateInput } from "@workspace/domain/self-trade";
import type { MarketRegime, TradingSession } from "@workspace/domain/signal-intelligence";
import { assessAtiRegimeInstrument, atiInstrumentProfile, atiRegimeOutcome, boundAtiRegimeAssessment,
  scoreAtiRegimeTransitions, summarizeAtiRegimeTransitions, type AtiRegimeAssessment } from "../atiRegimeInstrument.js";

const barMs = 300_000;
const asOf = Date.parse("2026-11-24T08:06:00Z");
const closedAt = Math.floor(asOf / barMs) * barMs;
const baseline = { setup: "TREND_CONTINUATION", side: "BUY", outcome: "APPROVED" } as DecisionCandidate;

function market(regime: MarketRegime, session: TradingSession = "LONDON", options: {
  news?: DecisionCandidateInput["newsRisk"]; momentum?: "STEADY" | "EXPANDING"; unmeasured?: string[];
  closed?: number; bosChoch?: string; rejectionDetected?: boolean; structure?: string;
} = {}) {
  return { newsRisk: options.news ?? "low", signal: { regime, session: { session },
    lifecycleStage: "ENTRY_WINDOW_OPEN", scores: { unmeasured: options.unmeasured ?? [] },
    marketEvidence: { lastClosedCandleAt: new Date(options.closed ?? closedAt).toISOString() },
    earlyTrend: { blind: false, structure: options.structure ?? "HH_HL", momentum: options.momentum ?? "STEADY",
      pressure: "BUILDING_BULLISH", bosChoch: options.bosChoch ?? "NONE", rejectionDetected: options.rejectionDetected ?? false },
  } } as DecisionCandidateInput;
}

function assess(symbol: string, input: DecisionCandidateInput, candidate = baseline) {
  const result = assessAtiRegimeInstrument(candidate, input, asOf, atiInstrumentProfile(symbol));
  assert.ok(result);
  return result;
}

test("instrument rules preserve V75 editions and withhold unvalidated spike risk", () => {
  const offHoursNews = market("TRENDING", "OFF_HOURS", { news: "critical" });
  assert.equal(assess("V75", offHoursNews).action, "KEEP");
  const fast = assess("1HZ75V", offHoursNews);
  assert.equal(fast.instrument?.canonicalSymbol, "V75_1S");
  assert.equal(fast.action, "REDUCE");
  assert.ok(fast.reasons.includes("V75_1S_EXPOSURE_CAP"));
  assert.equal(assess("V25_1S", offHoursNews).action, "WAIT");
  assert.equal(assess("V25_1S", market("TRENDING", "OFF_HOURS", { momentum: "EXPANDING" })).action, "KEEP");
  assert.ok(assess("BOOM500", offHoursNews).reasons.includes("SPIKE_RISK_MODEL_UNVALIDATED"));
  assert.ok(assess("CRASH500", offHoursNews).reasons.includes("SPIKE_RISK_MODEL_UNVALIDATED"));
  assert.equal(assess("UNKNOWN-FEED-TEST", offHoursNews).action, "WAIT");
});

test("session-aware markets use their own preference and measured macro evidence", () => {
  assert.equal(assess("EURUSD", market("TRENDING", "OFF_HOURS")).action, "WAIT");
  assert.equal(assess("EURUSD", market("TRENDING", "TOKYO")).action, "REDUCE");
  assert.equal(assess("EURUSD", market("TRENDING", "LONDON")).action, "KEEP");
  assert.equal(assess("EURUSD", market("TRENDING", "LONDON", { news: "critical" })).action, "WAIT");
  const unknownNews = assess("EURUSD", market("TRENDING", "LONDON", { news: "critical", unmeasured: ["newsSafety"] }));
  assert.equal(unknownNews.action, "KEEP");
  assert.ok(unknownNews.evidenceGaps.includes("MACRO_RISK_UNMEASURED"));
  const reversal = { ...baseline, setup: "REVERSAL" as const };
  assert.ok(assess("XAUUSD", market("VOLATILE", "LONDON", { bosChoch: "CHOCH_UP" }), reversal).reasons.includes("METAL_VOLATILITY_PAUSE"));
  assert.equal(assess("BTCUSD", market("TRENDING", "OFF_HOURS")).action, "KEEP");
  const breakout = { ...baseline, setup: "BREAKOUT_RETEST" as const };
  assert.ok(assess("BTCUSD", market("BREAKOUT", "OFF_HOURS", { bosChoch: "BOS_UP" }), breakout).reasons.includes("CRYPTO_BREAKOUT_EXPOSURE_CAP"));
});

test("setup checks wait for structural confirmation and cannot reopen a blocked baseline", () => {
  assert.equal(assess("V75", market("RANGING")).action, "WAIT");
  assert.equal(assess("V75", market("TRENDING", "LONDON", { structure: "LH_LL" })).action, "WAIT");
  const sweep = { ...baseline, setup: "LIQUIDITY_SWEEP" as const };
  assert.equal(assess("V75", market("VOLATILE"), sweep).action, "WAIT");
  const aligned = assess("V75", market("VOLATILE", "LONDON", { bosChoch: "CHOCH_UP", rejectionDetected: true }), sweep);
  assert.equal(aligned.action, "REDUCE");
  assert.equal(atiRegimeOutcome("BLOCKED", aligned), "BLOCKED");
  assert.equal(atiRegimeOutcome("APPROVED_REDUCED", assess("V75", market("TRENDING"))), "APPROVED_REDUCED");
  assert.equal(assessAtiRegimeInstrument(baseline, market("TRENDING", "LONDON", { closed: asOf + 1 }), asOf, atiInstrumentProfile("V75")), null);
});

test("transition frequencies require adjacent, known bars and preserve the instrument binding", () => {
  const receipt = assess("V75", market("TRENDING"));
  assert.equal(boundAtiRegimeAssessment(receipt, { observedAtMs: asOf, observationKey: `bar:${closedAt}`,
    instrument: atiInstrumentProfile("V75_1S") }), false);
  const point = (index: number, regime: MarketRegime): AtiRegimeAssessment => ({
    ...receipt, closedBarAtMs: closedAt + index * barMs, assessedAtMs: asOf + index * barMs, regime,
  });
  const sparse = summarizeAtiRegimeTransitions([point(0, "TRENDING"), point(1, "TRENDING"), point(3, "RANGING"),
    point(4, "UNKNOWN"), point(5, "TRENDING")], barMs);
  assert.equal(sparse.byFromRegime.find((r) => r.from === "TRENDING")?.sample, 1);
  assert.equal(sparse.byFromRegime.find((r) => r.from === "RANGING")?.sample, 0);
  assert.equal(sparse.byFromRegime.find((r) => r.from === "TRENDING")?.to.find((r) => r.regime === "TRENDING")?.probability, null);
  const measured = summarizeAtiRegimeTransitions(Array.from({ length: 21 }, (_, i) => point(i, "TRENDING")), barMs);
  assert.equal(measured.byFromRegime.find((r) => r.from === "TRENDING")?.to.find((r) => r.regime === "TRENDING")?.probability, 1);
  const development = summarizeAtiRegimeTransitions(Array.from({ length: 30 }, (_, i) =>
    point(i, i % 3 === 2 ? "RANGING" : "TRENDING")), barMs);
  const score = scoreAtiRegimeTransitions(development,
    [point(40, "TRENDING"), point(41, "RANGING"), point(42, "TRENDING"), point(43, "TRENDING")], barMs);
  assert.equal(score.eligibleTransitions, 3);
  assert.equal(score.scoredTransitions, 2);
  assert.equal(score.modelBrier, 0.5);
  assert.equal(score.persistenceBrier, 1);
});
