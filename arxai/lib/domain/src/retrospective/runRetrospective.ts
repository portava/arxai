import { computeEntryQuality } from "./entryQuality.engine";
import { computeExitQuality } from "./exitQuality.engine";
import { scoreAgents } from "./agentScoring.engine";
import { computeConfidenceCalibration } from "./confidenceCalibration.engine";
import { computeRiskSizing } from "./riskSizing.engine";
import { evaluateTraderBehavior } from "./traderBehavior.engine";
import { generateNextTimeRecommendations } from "./nextTimeRecommendations.engine";
import type { ClosedTradeRecord, RetrospectiveResult } from "./retrospective.types";

// runRetrospective
//
// Pure orchestrator: runs all 7 verdict engines on a closed trade, then
// passes the 6 verdicts into the synthesis engine for Q8 (next-time
// recommendations). The synthesis engine consumes pre-computed verdicts
// directly so its citations are guaranteed to match the bundle.
export function runRetrospective(rec: ClosedTradeRecord): RetrospectiveResult {
  const now = rec.now ?? new Date();

  const entry      = computeEntryQuality(rec);
  const exit       = computeExitQuality(rec);
  const agents     = scoreAgents(rec);
  const confidence = computeConfidenceCalibration(rec);
  const risk       = computeRiskSizing(rec);
  const behavior   = evaluateTraderBehavior(rec);
  const nextTime   = generateNextTimeRecommendations({
    entry, exit, agents, confidence, risk, behavior,
  });

  return {
    tradeId: rec.outcome.tradeId,
    evaluatedAt: now.toISOString(),
    entry, exit, agents, confidence, risk, behavior, nextTime,
  };
}
