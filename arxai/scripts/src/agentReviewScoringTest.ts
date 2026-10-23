// Trade-review scoring + lifecycle unit tests (PURE, no DB). Verifies the §5/§6
// invariants: profit alone is never a reward, no-trade reward equals the trade
// reward, authority bands clamp, and Promotion-Board poor-count thresholds fire.
//
// Run: pnpm --filter @workspace/scripts run test:agent-review-scoring

import {
  scoreTradeReview, REWARD_CATALOG, PENALTY_CATALOG,
  resolvePredictionOutcome,
  evaluateAgentLifecycle, AUTHORITY_BANDS, clampAuthorityToBand,
  nextCampStage, buildCorrectionRules, shouldEnterLearningCamp,
  nextAggregates,
  type ReviewSummary, type ReviewablePrediction,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

const now = new Date("2026-06-03T00:00:00Z");

const base: ReviewablePrediction = {
  predictionId: "p", agentId: 1, decision: "approve", direction: "BUY",
  confidenceScore: 70, slSuggestion: 1.0, tpSuggestion: 1.2,
  entryZone: "1.10", invalidationZone: "0.99",
  reasoningSummary: "clean trend continuation off support",
};

console.log("Agent review scoring test");

// 1. Catalog invariant (§14): no-trade reward == trade reward.
check(
  "no-trade reward weight equals trade reward weight",
  REWARD_CATALOG.correct_no_trade === REWARD_CATALOG.profitable_trade_taken,
);

// 2. Profit alone is NOT a reward (§5): a reckless win (no stop) scores worse
//    than a disciplined loss (clean structure).
const recklessWin = scoreTradeReview({
  prediction: { ...base, slSuggestion: null, entryZone: null, invalidationZone: null },
  outcome: { realizedOutcome: "WIN", realizedPnlR: 2 }, now,
});
const cleanLoss = scoreTradeReview({
  prediction: { ...base, confidenceScore: 60 },
  outcome: { realizedOutcome: "LOSS", realizedPnlR: -0.8 }, now,
});
check("reckless win flags reckless_win_no_stop", recklessWin.penaltyTags.includes("reckless_win_no_stop"));
check("reckless win has low protection score", recklessWin.protectionScore < 30);
check("disciplined loss out-scores reckless win", cleanLoss.scoreDelta > recklessWin.scoreDelta);

// 3. Correct no-trade earns the correct_no_trade reward and protects capital.
const correctNoTrade = scoreTradeReview({
  prediction: { ...base, decision: "no_trade", direction: "NONE" },
  outcome: { realizedOutcome: "NO_TRADE_CORRECT", realizedPnlR: null }, now,
});
check("correct no-trade rewards correct_no_trade", correctNoTrade.rewardTags.includes("correct_no_trade"));
check("correct no-trade is positively graded", correctNoTrade.scoreDelta > 0);

// 4. Sub-scores stay within 0..100 and grade in A..F.
const allScores = [recklessWin, cleanLoss, correctNoTrade];
check("all sub-scores within 0..100", allScores.every((r) =>
  [r.decisionQuality, r.outcomeScore, r.protectionScore, r.speedScore, r.usefulnessScore, r.calibrationScore]
    .every((s) => s >= 0 && s <= 100)));
check("scoreDelta within -2..2", allScores.every((r) => r.scoreDelta >= -2 && r.scoreDelta <= 2));

// 5. Penalty catalog has the repeated-corrected-mistake heavy penalty.
check("repeated_corrected_mistake is the heaviest penalty",
  PENALTY_CATALOG.repeated_corrected_mistake >= Math.max(...Object.values(PENALTY_CATALOG)));

// 6. Rolling aggregate EMA moves toward the new sub-score, never out of band.
const agg = nextAggregates({
  current: { qualityScore: 50, speedScore: 50, protectionScore: 50, usefulnessScore: 50, calibrationScore: 50, trustScore: 50 },
  review: correctNoTrade,
});
check("aggregates stay within 0..100", Object.values(agg).every((v) => v >= 0 && v <= 100));

// 7. Outcome resolver: no-trade that ran favorably = MISSED; quiet = CORRECT.
const missed = resolvePredictionOutcome({ decision: "no_trade", direction: "BUY" },
  { favorableMovePct: 1.0, adverseMovePct: 0.1, ageMs: 10, expiryMs: 1000 });
check("no-trade with strong favorable move = NO_TRADE_MISSED", missed.status === "NO_TRADE_MISSED" && missed.resolvable);
const avoided = resolvePredictionOutcome({ decision: "reject", direction: "BUY" },
  { favorableMovePct: 0.05, adverseMovePct: 0.05, ageMs: 2000, expiryMs: 1000 });
check("no-trade quiet past expiry = NO_TRADE_CORRECT", avoided.status === "NO_TRADE_CORRECT" && avoided.resolvable);
const pending = resolvePredictionOutcome({ decision: "approve", direction: "BUY" }, { ageMs: 10, expiryMs: 1000 });
check("fresh trade with no evidence stays UNRESOLVED (no fabrication)", pending.status === "UNRESOLVED" && !pending.resolvable);
const closedWin = resolvePredictionOutcome({ decision: "approve", direction: "BUY" },
  { closedTradeExists: true, closedTradePnlR: 1.5, ageMs: 10, expiryMs: 1000 });
check("closed +1.5R trade = WIN", closedWin.status === "WIN" && closedWin.pnlR === 1.5);

// 7b. FAIL-CLOSED: elapsed time alone NEVER resolves an outcome (no fabrication).
const agedTradeNoEv = resolvePredictionOutcome({ decision: "approve", direction: "BUY" },
  { ageMs: 9_999_999, expiryMs: 1000 });
check("aged trade with NO evidence stays UNRESOLVED (no EXPIRED-on-timeout)",
  agedTradeNoEv.status === "UNRESOLVED" && !agedTradeNoEv.resolvable);
const agedNoTradeNoEv = resolvePredictionOutcome({ decision: "no_trade", direction: "NONE" },
  { ageMs: 9_999_999, expiryMs: 1000 });
check("aged no-trade with NO candle evidence stays UNRESOLVED (no NO_TRADE_CORRECT-on-timeout)",
  agedNoTradeNoEv.status === "UNRESOLVED" && !agedNoTradeNoEv.resolvable);
const agedObserveNoEv = resolvePredictionOutcome({ decision: "observe", direction: null },
  { ageMs: 9_999_999, expiryMs: 1000 });
check("aged observation stays UNRESOLVED (never graded)",
  agedObserveNoEv.status === "UNRESOLVED" && !agedObserveNoEv.resolvable);
const agedTradeFlatEv = resolvePredictionOutcome({ decision: "approve", direction: "BUY" },
  { favorableMovePct: 0.1, adverseMovePct: 0.1, ageMs: 9_999_999, expiryMs: 1000 });
check("aged trade WITH real flat candle evidence = BREAKEVEN (evidence-based)",
  agedTradeFlatEv.status === "BREAKEVEN" && agedTradeFlatEv.resolvable);

// 8. Authority bands: Trainee/Shadow is 0%, clamp respects band.
check("TRAINEE band is 0%", AUTHORITY_BANDS.TRAINEE.min === 0 && AUTHORITY_BANDS.TRAINEE.max === 0);
check("clamp pins weight into ANALYST band", clampAuthorityToBand(0.99, "ANALYST") === AUTHORITY_BANDS.ANALYST.max);

// 9. Promotion Board poor-count thresholds (§6).
const poor = (n: number): ReviewSummary[] =>
  Array.from({ length: 10 }, (_, i) => i < n ? { grade: "F" as const, scoreDelta: -1.5 } : { grade: "B" as const, scoreDelta: 1 });
const evalAt = (n: number) => evaluateAgentLifecycle({
  currentStatus: "ACTIVE", currentRank: "ANALYST", currentAuthorityWeight: 0.07,
  liveInfluenceAllowed: true, reviews: poor(n),
});
check("3 poor -> WARNING", evalAt(3).recommendedStatus === "WARNING");
check("5 poor -> PROBATION", evalAt(5).recommendedStatus === "PROBATION");
check("8 poor -> LEARNING_CAMP", evalAt(8).recommendedStatus === "LEARNING_CAMP");
check("10 poor -> SHUTDOWN_RECOMMENDED + requiresAdmin", evalAt(10).recommendedStatus === "SHUTDOWN_RECOMMENDED" && evalAt(10).requiresAdmin);

// 10. A SHADOW agent (no live influence) keeps authority weight 0 even when promoted.
const shadowPromo = evaluateAgentLifecycle({
  currentStatus: "SHADOW", currentRank: "JUNIOR", currentAuthorityWeight: 0,
  liveInfluenceAllowed: false,
  reviews: Array.from({ length: 25 }, () => ({ grade: "A" as const, scoreDelta: 1.8 })),
});
check("promoted shadow agent keeps authorityWeight 0", shadowPromo.recommendedAuthorityWeight === 0);
check("promoted shadow agent rank still rises", shadowPromo.action === "PROMOTE");

// 11. Learning Camp stage machine + correction rules.
check("camp FAILURE_REVIEW -> PATTERN_CORRECTION", nextCampStage("FAILURE_REVIEW", true) === "PATTERN_CORRECTION");
check("camp SHADOW_MODE improved -> SUPERVISED_RETURN", nextCampStage("SHADOW_MODE", true) === "SUPERVISED_RETURN");
check("camp SHADOW_MODE not improved -> FURTHER_RESTRICTION", nextCampStage("SHADOW_MODE", false) === "FURTHER_RESTRICTION");
check("buildCorrectionRules maps ignored_sr", buildCorrectionRules(["ignored_sr"]).some((r) => r.includes("support/resistance")));
check("shouldEnterLearningCamp on 8 poor", shouldEnterLearningCamp({ poorRecent: 8 }) === true);

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll review-scoring checks passed.");
