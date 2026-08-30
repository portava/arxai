// Shadow-mode / validation-layer honesty guards (audit ranks 46, 66, 67, 69, 70).
//
// What was wrong:
//   46. AI Readiness averaged three TYPED CONSTANTS (overtradingBehavior: 100,
//       learningLoopStability: 80, safetyCompliance: 100) in with eight measured
//       factors, so ~27% of a readiness verdict on a live-trading system was
//       invented — and it pushed the label upward.
//   66. Confidence Calibration returned WELL_CALIBRATED for any monotonic slope
//       > 15 without ever comparing a stated confidence to the observed win rate.
//   67. The scanner's only candle source knows 8 symbols; the scan set was ~23
//       ARX markets. The other ~20 returned null on every tick, silently.
//   69. stopForwardTest() only nulled the config: the scanner kept running and
//       forwardResults() kept absorbing new decisions after Stop.
//   70. TOURNAMENT_STRATEGIES was a hand-written list of six names; the engine
//       emits a different set, so only 2 of 6 could ever match and four rows sat
//       at n=0 with a Promote button that could never enable.

// SAFETY: offline. The dummy unroutable DATABASE_URL only satisfies
// @workspace/db's import-time env check (pulled in via shadowPersistence).
// Nothing here connects, queries, or dispatches; shadow decisions are
// observations and never orders.
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_STRATEGY_NAMES } from "../backtestStrategyRegistry.js";

// Dynamic so the DATABASE_URL stub above is in place before @workspace/db's
// import-time env check runs (shadowMode → shadowPersistence → db).
const {
  readinessScore, READINESS_NOT_MEASURED,
  confidenceCalibration, labelCalibration, MIN_CALIBRATION_SAMPLE,
  TOURNAMENT_STRATEGIES, tournamentResults,
  shadowCoveredSymbols, startShadowMode, stopShadowMode, shadowStatus,
  startForwardTest, stopForwardTest, forwardStatus,
  isGoldSymbol, isForexSymbol,
} = await import("../shadowMode.js");

// ── Rank 46 — no typed constants inside the composite ───────────────────────

test("AI readiness excludes the three unmeasured factors from the mean", () => {
  const r = readinessScore();
  for (const f of ["overtradingBehavior", "learningLoopStability", "safetyCompliance"]) {
    assert.ok(!(f in r.factors), `${f} was a typed constant and must not be a scored factor`);
  }
  assert.equal(r.partial, true);
  assert.equal(r.notMeasured.length, 3);
  assert.equal(r.measuredFactorCount, Object.keys(r.factors).length);
  assert.equal(r.totalFactorCount, r.measuredFactorCount + 3);
  for (const n of r.notMeasured) {
    assert.ok(n.reason.length > 20, `${n.factor} must say why it is not measured`);
    assert.ok(n.wouldNeed.length > 20, `${n.factor} must say what measuring it would take`);
  }
  assert.deepEqual(
    READINESS_NOT_MEASURED.map((n) => n.factor).sort(),
    ["learningLoopStability", "overtradingBehavior", "safetyCompliance"],
  );
});

test("AI readiness declares its synthetic provenance", () => {
  const r = readinessScore();
  assert.equal(r.dataSource, "SHADOW");
  assert.equal(r.candleSource, "SYNTHETIC_SIMULATOR");
  assert.match(r.basis, /synthetic simulator/i);
  assert.match(r.basis, /not a live-readiness certification/i);
});

test("the readiness score is the mean of the measured factors only", () => {
  const r = readinessScore();
  const vals = Object.values(r.factors);
  const expected = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  assert.equal(r.score, expected);
});

// ── Rank 66 — calibration is measured, not inferred from ordering ────────────

test("the audit's counterexample is NOT labelled calibrated", () => {
  // 90-100 bucket wins 45% (claimed ~95), 50-60 bucket wins 20% (claimed 55):
  // slope = +25 (monotonic), but the model is ~42 points wrong about its own
  // stated probabilities. The old rule returned WELL_CALIBRATED here.
  const label = labelCalibration({
    sample: 60,
    calibrationErrorPctPts: 42.5,
    signedErrorPctPts: 42.5,
    slopePctPts: 25,
  });
  assert.notEqual(label, "CALIBRATED_ON_SYNTHETIC_ONLY");
  assert.equal(label, "OVERCONFIDENT");
});

test("absolute accuracy is checked before the monotonicity shortcut", () => {
  // Small error, flat slope: accuracy wins — a flat-but-accurate model is
  // calibrated, and must not be dismissed as RANDOM_CONFIDENCE.
  assert.equal(
    labelCalibration({ sample: 40, calibrationErrorPctPts: 4, signedErrorPctPts: -1, slopePctPts: 0 }),
    "CALIBRATED_ON_SYNTHETIC_ONLY",
  );
  // Large error, flat slope: confidence carries no information.
  assert.equal(
    labelCalibration({ sample: 40, calibrationErrorPctPts: 30, signedErrorPctPts: 30, slopePctPts: 1 }),
    "RANDOM_CONFIDENCE",
  );
  // Large error, delivered more than claimed.
  assert.equal(
    labelCalibration({ sample: 40, calibrationErrorPctPts: 25, signedErrorPctPts: -25, slopePctPts: 20 }),
    "UNDERCONFIDENT",
  );
});

test("no verdict without a sample", () => {
  assert.equal(
    labelCalibration({ sample: MIN_CALIBRATION_SAMPLE - 1, calibrationErrorPctPts: 0, signedErrorPctPts: 0, slopePctPts: 40 }),
    "NEEDS_MORE_DATA",
  );
  assert.equal(
    labelCalibration({ sample: 100, calibrationErrorPctPts: null, signedErrorPctPts: null, slopePctPts: 40 }),
    "NEEDS_MORE_DATA",
  );
});

test("calibration never emits a bare WELL_CALIBRATED on synthetic samples", () => {
  const c = confidenceCalibration();
  assert.notEqual(c.label, "WELL_CALIBRATED");
  assert.equal(c.dataSource, "SHADOW");
  assert.equal(c.candleSource, "SYNTHETIC_SIMULATOR");
  // Each bucket exposes what was CLAIMED alongside what was observed.
  for (const b of c.buckets) {
    assert.equal(typeof b.expectedWinRate, "number");
    assert.ok("errorPctPts" in b);
  }
});

// ── Rank 67 — coverage is reported, not implied ─────────────────────────────

test("shadow status reports scanned and skipped symbols", () => {
  stopShadowMode();
  const requested = ["EURUSD", "V75", "XAUUSD", "BOOM1000", "DXY"];
  const started = startShadowMode({ symbols: requested, intervalSec: 3600 });
  try {
    const covered = new Set(shadowCoveredSymbols().map((s) => s.toUpperCase()));
    // Only symbols the data source actually covers are scanned.
    for (const s of started.scannedSymbols) assert.ok(covered.has(s.toUpperCase()), `${s} is not covered`);
    // The rest are named, not dropped in silence.
    for (const s of started.skippedSymbols) assert.ok(!covered.has(s.toUpperCase()));
    assert.equal(
      started.scannedSymbols.length + started.skippedSymbols.length,
      requested.length,
      "every requested symbol must be accounted for",
    );
    assert.ok(started.skippedSymbols.includes("V75"), "V75 has no simulator candles and must be reported skipped");

    const st = shadowStatus();
    assert.equal(st.skippedSymbolCount, started.skippedSymbols.length);
    assert.equal(st.candleSource, "SYNTHETIC_SIMULATOR");
    assert.match(st.coverageNote, /NOT shadow-tested/);
    assert.match(st.coverageNote, /V75/);
  } finally {
    stopShadowMode();
  }
});

// ── Rank 69 — Stop freezes the window ───────────────────────────────────────

test("stopping a forward test freezes its window and stops a scanner it started", () => {
  stopShadowMode();
  startForwardTest({ durationMin: 60 });
  assert.equal(forwardStatus().running, true);
  assert.equal(forwardStatus().windowFrozen, false);

  const stopped = stopForwardTest();
  assert.equal(stopped.stopped, true);
  assert.ok(stopped.endedAt, "Stop must record when the window closed");
  assert.equal(stopped.scannerStopped, true, "the scanner this test started must be stopped again");

  const after = forwardStatus();
  assert.equal(after.running, false);
  assert.equal(after.windowFrozen, true);
  assert.equal(after.endedAt, stopped.endedAt);
  assert.equal(shadowStatus().enabled, false);
  stopShadowMode();
});

// ── Rank 70 — the tournament universe comes from the engine ─────────────────

test("the tournament universe is the engine's own strategy set", () => {
  assert.deepEqual([...TOURNAMENT_STRATEGIES].sort(), [...ENGINE_STRATEGY_NAMES].sort());
  // The four names that could never be produced by a scan are gone.
  for (const ghost of ["Conservative Pullback", "Breakout Confirmation", "Gold Scalping Test", "Custom Strategy"]) {
    assert.ok(!TOURNAMENT_STRATEGIES.includes(ghost), `${ghost} can never produce a decision`);
  }
});

test("leaderboard slots that cannot be computed are declared, not shown as dashes", () => {
  const t = tournamentResults();
  assert.ok(!("bestScalping" in t.leaderboard), "an uncomputable slot must not be rendered");
  assert.ok(!("bestGold" in t.leaderboard), "the name-matched gold slot is replaced by a symbol-derived one");
  assert.ok("bestOnGold" in t.leaderboard, "gold is now derived from the decision's symbol");
  assert.match(t.notComputed.bestScalping, /holding-period|timeframe/i);
});

// `bestForex` carried the same name-regex defect as `bestGold` and survived the
// first pass. Unlike the two slots that were replaced, it actually RENDERED a
// value: /pullback|trend|break/i matches four of the seven engine strategy
// names, so a sample containing only XAUUSD or BTCUSD decisions still filled a
// card labelled BEST FOREX with a strategy that had never traded a currency
// pair. The category must come from the decision's SYMBOL, never its strategy
// name.
test("the forex slot is derived from the symbol, not from the strategy's name", () => {
  const t = tournamentResults();
  assert.ok(!("bestForex" in t.leaderboard), "the name-matched forex slot is gone");
  assert.ok("bestOnForex" in t.leaderboard, "forex is derived from the decision's symbol");
});

test("category predicates classify by symbol through the ARX registry", () => {
  // Four of the seven engine strategy names matched the old /pullback|trend|break/i
  // regex — none of them is evidence a currency pair was traded.
  const namesThatFooledTheOldRegex = ENGINE_STRATEGY_NAMES
    .filter((n) => /pullback|trend|break/i.test(n));
  assert.ok(namesThatFooledTheOldRegex.length >= 3,
    "the old regex really did match most of the engine's strategies");
  for (const name of namesThatFooledTheOldRegex) {
    assert.equal(isForexSymbol(name), false, `${name} is a strategy name, not a forex symbol`);
  }

  assert.equal(isForexSymbol("EURUSD"), true);
  assert.equal(isForexSymbol("GBPJPY"), true);
  assert.equal(isForexSymbol("XAUUSD"), false, "gold is a metal, not forex");
  assert.equal(isForexSymbol("V75"), false, "a synthetic index is not forex");
  assert.equal(isForexSymbol("NOT_A_SYMBOL"), false, "an unknown symbol is excluded, never guessed");

  assert.equal(isGoldSymbol("XAUUSD"), true);
  assert.equal(isGoldSymbol("EURUSD"), false);
  assert.equal(isGoldSymbol("Gold Scalping Test"), false, "a strategy name is not a symbol");
});
