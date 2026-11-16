import {
  type AgentVerdict, type DebateReport, type DirectionVerdict, type HardBlockVerdict,
  type ProposedDecision, type QualityVerdict, type TradeDirection,
  AGENT_SYSTEM_THRESHOLDS,
} from "../agentSystem.types";

// tradeJudge — synthesizes verdicts + debate into a PROPOSED decision.
// The judge cannot execute trades; it only proposes. Governor has final say.
//
// Decision logic:
//   • Any HardBlock veto → REJECT (judge surfaces the proposal as REJECT
//     so the audit trail stays complete; governor will confirm).
//   • Below directional consensus floor → REJECT.
//   • Average quality < rejectBelowAvg → REJECT.
//   • Average quality ≤ reduceAtOrBelowAvg → APPROVE_REDUCED.
//   • Otherwise → APPROVE.
//
// Proposed direction must agree with proposed setup direction; if consensus
// disagrees, judge proposes REJECT rather than silently flipping the side.
export function tradeJudge(
  verdicts: AgentVerdict[],
  debate: DebateReport,
  proposedSetupDirection: TradeDirection,
): ProposedDecision {
  const T = AGENT_SYSTEM_THRESHOLDS;
  const rationale: string[] = [];
  const contributingAgentIds = verdicts.map((v) => v.agentId);

  const hardBlocks = verdicts.filter((v): v is HardBlockVerdict => v.category === "HARD_BLOCK");
  const vetoed = hardBlocks.filter((b) => b.vetoed);
  if (vetoed.length > 0) {
    rationale.push(`REJECT — hard block(s): ${vetoed.map((b) => b.agentName).join(", ")}`);
    return rejection(rationale, contributingAgentIds);
  }

  // Direction consensus
  const dirVerdicts = verdicts.filter((v): v is DirectionVerdict =>
    v.category === "DIRECTION" && v.direction !== "ABSTAIN" && v.conviction >= T.direction.minConvictionToVote);
  if (dirVerdicts.length === 0) {
    rationale.push("REJECT — no direction agent passed the conviction floor");
    return rejection(rationale, contributingAgentIds);
  }
  const buy  = dirVerdicts.filter((v) => v.direction === "BUY");
  const sell = dirVerdicts.filter((v) => v.direction === "SELL");
  let consensus: TradeDirection | null;
  let agreeing: DirectionVerdict[];
  if (buy.length > sell.length)      { consensus = "BUY";  agreeing = buy; }
  else if (sell.length > buy.length) { consensus = "SELL"; agreeing = sell; }
  else                               { consensus = null;   agreeing = []; }

  if (consensus === null) {
    rationale.push("REJECT — direction agents tied; no consensus");
    return rejection(rationale, contributingAgentIds);
  }
  const agreement01 = agreeing.length / dirVerdicts.length;
  if (agreement01 < T.direction.minAgreementForConsensus01) {
    rationale.push(`REJECT — directional agreement ${(agreement01 * 100).toFixed(0)}% < ${(T.direction.minAgreementForConsensus01 * 100).toFixed(0)}% floor`);
    return rejection(rationale, contributingAgentIds);
  }
  if (consensus !== proposedSetupDirection) {
    rationale.push(`REJECT — agent consensus ${consensus} contradicts proposed setup ${proposedSetupDirection}`);
    return rejection(rationale, contributingAgentIds);
  }

  const avgConviction = agreeing.reduce((s, v) => s + v.conviction, 0) / agreeing.length;

  // Quality
  const qVerdicts = verdicts.filter((v): v is QualityVerdict => v.category === "QUALITY");
  const avgQuality = qVerdicts.length === 0
    ? 50
    : qVerdicts.reduce((s, v) => s + v.qualityScore, 0) / qVerdicts.length;

  if (avgQuality < T.quality.rejectBelowAvg) {
    rationale.push(`REJECT — average quality ${avgQuality.toFixed(0)} < reject floor ${T.quality.rejectBelowAvg}`);
    return rejection(rationale, contributingAgentIds);
  }

  // Confidence: 50% directional × agreement, 50% quality
  const directionalScore = avgConviction * agreement01;
  const confidence = Math.max(0, Math.min(100, 0.5 * directionalScore + 0.5 * avgQuality));
  const sizeMultiplier = T.quality.multiplierMin
    + (T.quality.multiplierMax - T.quality.multiplierMin) * (avgQuality / 100);

  const action: ProposedDecision["action"] =
    avgQuality <= T.quality.reduceAtOrBelowAvg ? "APPROVE_REDUCED" : "APPROVE";

  rationale.push(
    `${action} — direction ${consensus} (agreement ${(agreement01 * 100).toFixed(0)}%, conviction ${avgConviction.toFixed(0)}), quality ${avgQuality.toFixed(0)}, confidence ${confidence.toFixed(0)}`,
  );
  if (debate.conflicts.length > 0) {
    rationale.push(`note: ${debate.conflicts.length} conflict(s) flagged in debate`);
  }

  return {
    action, direction: consensus, confidence, sizeMultiplier,
    rationale, contributingAgentIds,
  };
}

function rejection(rationale: string[], ids: string[]): ProposedDecision {
  return {
    action: "REJECT", direction: null, confidence: 0, sizeMultiplier: 0,
    rationale, contributingAgentIds: ids,
  };
}
