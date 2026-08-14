// Ruby Quality — Outcome Learning & Admin Quality (Task #199) — PURE engine tests.
//
// Honesty contracts verified here:
//  1. resolveSignalOutcome reuses the proven fail-closed resolver — elapsed time
//     alone NEVER grades (stays UNRESOLVED/resolvable:false); exit reason is
//     derived only from real evidence and is null for a trade never taken.
//  2. classifyEntryTiming returns null on a missing entry timestamp (no
//     fabricated timing verdict).
//  3. evaluateNoTradeCredit credits an avoidance ONLY on NO_TRADE_CORRECT.
//  4. buildSignalSelfReview emits a user summary with NO internal enum tokens and
//     an admin-only detail breakdown.
//  5. computeRubyQualityMetrics never counts PENDING/UNRESOLVED rows toward a
//     win/loss rate.
//  6. clampThresholds bounds every knob and drops unknown keys.
//  7. buildMissedOpportunityReplay reconstructs only from recorded evidence.
//
// No DB, no IO. Run: pnpm --filter @workspace/scripts run test:ruby-quality

import {
  classifyEntryTiming,
  resolveSignalOutcome,
  evaluateNoTradeCredit,
  buildSignalSelfReview,
  computeRubyQualityMetrics,
  clampThresholds,
  DEFAULT_RUBY_THRESHOLDS,
  buildMissedOpportunityReplay,
  type SelfReviewInput,
  type QualitySampleRow,
} from "@workspace/domain/ruby-quality";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

console.log("Ruby Quality engine test");

// ----- classifyEntryTiming -------------------------------------------------
const SIG = Date.parse("2026-06-05T12:00:00Z");
check("timing: null entry → null (no fabrication)",
  classifyEntryTiming({ signalAtMs: SIG, entryAtMs: null, lateEntrySeconds: 120 }) === null);
check("timing: entered before signal → EARLY",
  classifyEntryTiming({ signalAtMs: SIG, entryAtMs: SIG - 5000, lateEntrySeconds: 120 }) === "EARLY");
check("timing: within tolerance → ON_TIME",
  classifyEntryTiming({ signalAtMs: SIG, entryAtMs: SIG + 60_000, lateEntrySeconds: 120 }) === "ON_TIME");
check("timing: past tolerance → LATE",
  classifyEntryTiming({ signalAtMs: SIG, entryAtMs: SIG + 200_000, lateEntrySeconds: 120 }) === "LATE");

// ----- resolveSignalOutcome (fail-closed) ----------------------------------
const timeOnly = resolveSignalOutcome({ decision: "approve", direction: "BUY" }, { ageMs: 99_999_999, expiryMs: 1000 });
check("resolve: time-only trade stays UNRESOLVED", timeOnly.status === "UNRESOLVED");
check("resolve: time-only trade is not resolvable", timeOnly.resolvable === false);
check("resolve: time-only has null exitReason", timeOnly.exitReason === null);

const winTrade = resolveSignalOutcome({ decision: "approve", direction: "BUY" },
  { closedTradeExists: true, closedTradePnlR: 1.8, userEntered: true });
check("resolve: closed +R → WIN", winTrade.status === "WIN");
check("resolve: WIN entered → exitReason TP", winTrade.exitReason === "TP");

const lossTrade = resolveSignalOutcome({ decision: "approve", direction: "BUY" },
  { closedTradeExists: true, closedTradePnlR: -1.0, userEntered: true });
check("resolve: closed -R → LOSS", lossTrade.status === "LOSS");
check("resolve: LOSS entered → exitReason SL", lossTrade.exitReason === "SL");

const noTradeCorrect = resolveSignalOutcome({ decision: "no_trade", direction: "NONE" },
  { favorableMovePct: 0.1, adverseMovePct: 0.05, ageMs: 5000, expiryMs: 1000 });
check("resolve: avoided low-move setup → NO_TRADE_CORRECT", noTradeCorrect.status === "NO_TRADE_CORRECT");
check("resolve: no-trade never has an exitReason", noTradeCorrect.exitReason === null);

const invalidated = resolveSignalOutcome({ decision: "approve", direction: "BUY" },
  { closedTradeExists: true, closedTradePnlR: -1.0, userEntered: true, invalidated: true });
check("resolve: invalidation evidence → exitReason INVALIDATED", invalidated.exitReason === "INVALIDATED");

// ----- evaluateNoTradeCredit ------------------------------------------------
check("credit: NO_TRADE_CORRECT is credited",
  evaluateNoTradeCredit({ decision: "no_trade", outcomeStatus: "NO_TRADE_CORRECT" }).credited === true);
check("credit: NO_TRADE_MISSED not credited",
  evaluateNoTradeCredit({ decision: "no_trade", outcomeStatus: "NO_TRADE_MISSED" }).credited === false);
check("credit: PENDING avoidance not credited (no time-only credit)",
  evaluateNoTradeCredit({ decision: "reject", outcomeStatus: "PENDING" }).credited === false);
check("credit: a taken trade is never a no-trade credit",
  evaluateNoTradeCredit({ decision: "approve", outcomeStatus: "WIN" }).credited === false);

// ----- buildSignalSelfReview ------------------------------------------------
function reviewInput(o: Partial<SelfReviewInput>): SelfReviewInput {
  return {
    symbol: "EURUSD", direction: "BUY", decision: "approve", outcomeStatus: "WIN",
    pnlR: 1.8, userEntered: true, explanationUsed: true, timingClass: "ON_TIME",
    newsNearby: false, spreadAtSignal: 0.8, expectedSlippage: 0.5, actualSlippage: 0.6,
    expectedStartDrawdown: 0.3, actualStartDrawdown: 0.4, maxFavorableExcursion: 2.1,
    maxAdverseExcursion: 0.5, exitReason: "TP", confidenceScore: 78, edgeScore: 70,
    mistakeTags: [], successTags: ["clean_trend"], ...o,
  };
}
const winReview = buildSignalSelfReview(reviewInput({}));
check("review: POST_TRADE type for an entered trade", winReview.reviewType === "POST_TRADE");
check("review: user summary is non-empty", winReview.userSummary.trim().length > 0);
check("review: user summary leaks no UPPER_SNAKE enum token", !UPPER_SNAKE.test(winReview.userSummary));
check("review: admin detail carries an adjustment", winReview.adminDetail.adjustment.trim().length > 0);

const noTradeReview = buildSignalSelfReview(reviewInput({
  decision: "no_trade", direction: "NONE", outcomeStatus: "NO_TRADE_CORRECT",
  userEntered: false, exitReason: null, pnlR: null, timingClass: null,
}));
check("review: NO_TRADE type for an avoidance", noTradeReview.reviewType === "NO_TRADE");
check("review: no-trade user summary leaks no enum token", !UPPER_SNAKE.test(noTradeReview.userSummary));

// ----- computeRubyQualityMetrics -------------------------------------------
function sample(o: Partial<QualitySampleRow>): QualitySampleRow {
  return {
    symbol: "EURUSD", session: "london", decision: "approve", direction: "BUY",
    outcomeStatus: "WIN", pnlR: 1.5, timingClass: "ON_TIME", exitReason: "TP",
    newsNearby: false, userEntered: true, explanationUsed: true, noTradeCredited: false,
    confidenceScore: 80, edgeScore: 72, spreadAtSignal: 0.8, expectedSlippage: 0.5,
    actualSlippage: 0.5, expectedStartDrawdown: 0.3, actualStartDrawdown: 0.3,
    maxFavorableExcursion: 2.0, maxAdverseExcursion: 0.4, ...o,
  };
}
const rows: QualitySampleRow[] = [
  sample({}),
  sample({ outcomeStatus: "LOSS", exitReason: "SL", pnlR: -1.0, timingClass: "LATE" }),
  sample({ outcomeStatus: "WIN" }),
  sample({ decision: "no_trade", direction: "NONE", outcomeStatus: "NO_TRADE_CORRECT", userEntered: false, exitReason: null, noTradeCredited: true, pnlR: null }),
  sample({ decision: "no_trade", direction: "NONE", outcomeStatus: "NO_TRADE_MISSED", userEntered: false, exitReason: null, pnlR: null }),
  sample({ outcomeStatus: "PENDING", exitReason: null, pnlR: null }),
  sample({ outcomeStatus: "UNRESOLVED", exitReason: null, pnlR: null }),
];
const m = computeRubyQualityMetrics(rows);
check("metrics: tracked counts all rows", m.totals.tracked === 7);
check("metrics: graded excludes PENDING/UNRESOLVED/no-trade", m.totals.graded === 3);
check("metrics: winRate = 2/3 graded", m.rates.winRate === Math.round((2 / 3) * 1000) / 1000);
check("metrics: lateRate reflects 1 late of entered-timed", m.rates.lateRate > 0);
check("metrics: avoided bad trades counted", m.avoidedBadTrades === 1);
check("metrics: missed opportunities counted", m.missedOpportunities === 1);
check("metrics: confidence buckets present", m.confidenceVsOutcome.length === 4);

// ----- clampThresholds ------------------------------------------------------
const clamped = clampThresholds({ minConfidence: 999, lateEntrySeconds: -50, evidenceExpiryMinutes: 3.7 } as never);
check("clamp: over-max confidence clamped to 100", clamped.minConfidence === 100);
check("clamp: negative seconds clamped to 0", clamped.lateEntrySeconds === 0);
check("clamp: integer field rounded", clamped.evidenceExpiryMinutes === 4);
const dropped = clampThresholds({ bogusKey: 5 } as never);
check("clamp: unknown key dropped (defaults kept)", dropped.minConfidence === DEFAULT_RUBY_THRESHOLDS.minConfidence);

// ----- buildMissedOpportunityReplay ----------------------------------------
const replayFull = buildMissedOpportunityReplay({
  outcomeId: "o1", symbol: "GBPUSD", timeframe: "M5", session: "london", direction: "BUY",
  decision: "no_trade", outcomeStatus: "NO_TRADE_MISSED", confidenceScore: 65, edgeScore: 60,
  flameStage: null, newsNearby: false, spreadAtSignal: 1.0, entryPrice: 1.27, stopLoss: 1.265,
  takeProfit: 1.28, timingClass: null, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2,
  signalAtMs: SIG, resolvedAtMs: SIG + 600_000,
  observedPath: [{ tMs: SIG, price: 1.27 }, { tMs: SIG + 300_000, price: 1.276 }],
});
check("replay: complete path flagged dataComplete", replayFull.howItMoved.dataComplete === true);
check("replay: elapsed computed from timestamps", replayFull.howItMoved.elapsedMs === 600_000);
const replaySparse = buildMissedOpportunityReplay({
  outcomeId: "o2", symbol: "GBPUSD", timeframe: "M5", session: null, direction: "BUY",
  decision: "no_trade", outcomeStatus: "NO_TRADE_MISSED", confidenceScore: 65, edgeScore: null,
  flameStage: null, newsNearby: false, spreadAtSignal: null, entryPrice: null, stopLoss: null,
  takeProfit: null, timingClass: null, maxFavorableExcursion: null, maxAdverseExcursion: null,
  signalAtMs: SIG, resolvedAtMs: null,
});
check("replay: sparse path is honest (not complete)", replaySparse.howItMoved.dataComplete === false);
check("replay: sparse elapsed is null (never invented)", replaySparse.howItMoved.elapsedMs === null);

if (failures > 0) {
  console.error(`\nRuby Quality engine test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nRuby Quality engine test: all checks passed");

export {};
