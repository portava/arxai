import { isVoteFresh, type AgentName } from "./agents.types";
import {
  CONSENSUS_THRESHOLDS, DEFAULT_WEIGHTS,
  type ConsensusResult, type ConsensusWeights,
  type PerAgentBreakdown, type RunConsensusInput,
} from "./consensusVerdict.types";

// runConsensus
//
// Combines the 10 v2 agent votes into one of: EXECUTE | WAIT | REDUCE_SIZE
// | BLOCK | MONITOR_ONLY. Pure: no IO, no mutation. Algorithm:
//
//   1. Drop expired votes (each vote carries its own `expirationSeconds`).
//   2. Any fresh BLOCK vote → verdict BLOCK (every v2 agent's BLOCK is a
//      real don't-trade condition; we respect them all).
//   3. Otherwise weight each fresh vote by ConsensusWeights × confidence
//      and sum per-side contributions (BUY / SELL / WAIT).
//   4. Direction is the dominant side if it leads by ≥ splitGapMaxRatio of
//      its own score; otherwise null (a split).
//   5. executionConfidence = dominant_side_score / total_directional_capacity,
//      shaved by the WAIT-share penalty.
//   6. directionAgreement = dominant_side_weight / (BUY+SELL+WAIT weight).
//   7. Map to verdict using thresholds (see CONSENSUS_THRESHOLDS).
//
// Below `minFreshVotes` fresh inputs, we force WAIT — insufficient
// consensus to act on.
export function runConsensus(input: RunConsensusInput): ConsensusResult {
  const now = input.now ?? new Date();
  const weights: ConsensusWeights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const reasons: string[] = [];
  const blockers: string[] = [];

  // ── 1. Freshness partition + per-agent scaffolding ──────────────────────
  let freshVotesCount = 0;
  let expiredVotesCount = 0;
  const perAgent: PerAgentBreakdown[] = [];

  for (const cv of input.votes) {
    const fresh = isVoteFresh(cv.vote, cv.castAt, now);
    const weightApplied = weights[cv.agent];
    const breakdown: PerAgentBreakdown = {
      agent: cv.agent, vote: cv.vote, fresh, weightApplied,
      buyContribution: 0, sellContribution: 0, waitContribution: 0, blocking: false,
    };

    if (!fresh) {
      expiredVotesCount++;
      reasons.push(`[${cv.agent}] vote expired (${cv.vote.expirationSeconds}s window)`);
      perAgent.push(breakdown);
      continue;
    }

    freshVotesCount++;
    const w = weightApplied * cv.vote.confidence;
    if (cv.vote.vote === "BUY")  breakdown.buyContribution  = w;
    if (cv.vote.vote === "SELL") breakdown.sellContribution = w;
    if (cv.vote.vote === "WAIT") breakdown.waitContribution = w * 0.5;
    if (cv.vote.vote === "BLOCK") {
      breakdown.blocking = true;
      for (const b of cv.vote.blockers.length > 0 ? cv.vote.blockers : ["BLOCK with no blocker text"]) {
        blockers.push(`[${cv.agent}] ${b}`);
      }
    }
    perAgent.push(breakdown);
  }

  // ── 2. Hard block — any fresh BLOCK wins immediately ────────────────────
  const hardBlocked = perAgent.some((p) => p.fresh && p.blocking);
  if (hardBlocked) {
    return finalize({
      verdict: "BLOCK", direction: null,
      executionConfidence: 0, directionAgreement: 0, recommendedSizeMultiplier: 0,
      reasons: prependCount(reasons, freshVotesCount, expiredVotesCount, perAgent),
      blockers, freshVotesCount, expiredVotesCount, perAgent, now,
    });
  }

  // ── 3. Insufficient input → WAIT ───────────────────────────────────────
  if (freshVotesCount < CONSENSUS_THRESHOLDS.minFreshVotes) {
    reasons.unshift(`only ${freshVotesCount} fresh votes (need ≥ ${CONSENSUS_THRESHOLDS.minFreshVotes})`);
    return finalize({
      verdict: "WAIT", direction: null,
      executionConfidence: 0, directionAgreement: 0, recommendedSizeMultiplier: 0,
      reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
    });
  }

  // ── 4. Aggregate ───────────────────────────────────────────────────────
  let buyScore = 0, sellScore = 0, waitScore = 0;
  let buyAgentWeight = 0, sellAgentWeight = 0, waitAgentWeight = 0;
  for (const p of perAgent) {
    if (!p.fresh || p.blocking) continue;
    buyScore  += p.buyContribution;
    sellScore += p.sellContribution;
    waitScore += p.waitContribution;
    if (p.vote.vote === "BUY")  buyAgentWeight  += p.weightApplied;
    if (p.vote.vote === "SELL") sellAgentWeight += p.weightApplied;
    if (p.vote.vote === "WAIT") waitAgentWeight += p.weightApplied;
  }
  const totalDirectionalWeight = buyAgentWeight + sellAgentWeight + waitAgentWeight;

  // ── 5. Direction resolution ────────────────────────────────────────────
  const dominantScore = Math.max(buyScore, sellScore);
  const weakerScore   = Math.min(buyScore, sellScore);
  const splitGap      = dominantScore > 0 ? (dominantScore - weakerScore) / dominantScore : 0;

  let direction: "BUY" | "SELL" | null = null;
  if (buyScore > 0 || sellScore > 0) {
    if (splitGap >= CONSENSUS_THRESHOLDS.splitGapMaxRatio) {
      direction = buyScore > sellScore ? "BUY" : "SELL";
    }
  }
  reasons.push(
    `BUY weight ${buyScore.toFixed(0)}, SELL weight ${sellScore.toFixed(0)}, ` +
    `WAIT weight ${waitScore.toFixed(0)} (gap ${(splitGap * 100).toFixed(0)}%)`,
  );

  // ── 6. MONITOR_ONLY — directional split with substantial activity ──────
  if (direction === null && (buyScore > 0 || sellScore > 0)) {
    const totalActiveScore = buyScore + sellScore + waitScore;
    const buyShare  = totalActiveScore > 0 ? buyScore  / totalActiveScore : 0;
    const sellShare = totalActiveScore > 0 ? sellScore / totalActiveScore : 0;
    if (buyShare  >= CONSENSUS_THRESHOLDS.splitMinSideShare &&
        sellShare >= CONSENSUS_THRESHOLDS.splitMinSideShare) {
      reasons.unshift(`agents split: BUY ${(buyShare * 100).toFixed(0)}% vs SELL ${(sellShare * 100).toFixed(0)}%`);
      return finalize({
        verdict: "MONITOR_ONLY", direction: null,
        executionConfidence: Math.round(Math.max(buyShare, sellShare) * 100),
        directionAgreement: 0, recommendedSizeMultiplier: 0,
        reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
      });
    }
  }

  // ── 7. Compute confidence + agreement, then map to verdict ─────────────
  // Total possible directional capacity = sum of all fresh non-blocking
  // weights × 100 (max confidence). This bounds executionConfidence to 0..100.
  const totalCapacity = perAgent
    .filter((p) => p.fresh && !p.blocking)
    .reduce((s, p) => s + p.weightApplied * 100, 0);
  const rawConfidence = totalCapacity > 0 ? (dominantScore / totalCapacity) * 100 : 0;
  // Penalty for high WAIT share — agents with their hands up reduce confidence.
  const waitShare = totalCapacity > 0 ? (waitScore * 2) / totalCapacity : 0;     // ×2 reverses the *0.5 WAIT discount
  const executionConfidence = Math.max(0, Math.min(100, rawConfidence * (1 - waitShare * 0.4)));

  const dominantAgentWeight = direction === "BUY" ? buyAgentWeight
                            : direction === "SELL" ? sellAgentWeight : 0;
  const directionAgreement = totalDirectionalWeight > 0
    ? dominantAgentWeight / totalDirectionalWeight : 0;

  if (direction === null) {
    reasons.unshift("no clear direction — mostly WAIT votes");
    return finalize({
      verdict: "WAIT", direction: null,
      executionConfidence: Math.round(executionConfidence),
      directionAgreement: 0, recommendedSizeMultiplier: 0,
      reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
    });
  }

  if (executionConfidence >= CONSENSUS_THRESHOLDS.executeConfidence
      && directionAgreement >= CONSENSUS_THRESHOLDS.executeAgreement) {
    reasons.unshift(
      `EXECUTE: confidence ${executionConfidence.toFixed(0)} ≥ ${CONSENSUS_THRESHOLDS.executeConfidence}, ` +
      `agreement ${(directionAgreement * 100).toFixed(0)}% ≥ ${(CONSENSUS_THRESHOLDS.executeAgreement * 100).toFixed(0)}%`,
    );
    return finalize({
      verdict: "EXECUTE", direction,
      executionConfidence: Math.round(executionConfidence),
      directionAgreement, recommendedSizeMultiplier: 1.0,
      reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
    });
  }

  if (executionConfidence >= CONSENSUS_THRESHOLDS.reduceSizeConfFloor
      && directionAgreement >= CONSENSUS_THRESHOLDS.reduceSizeAgreement) {
    // Linear scale 0.25 → 0.75 across the REDUCE_SIZE confidence band
    const span = CONSENSUS_THRESHOLDS.executeConfidence - CONSENSUS_THRESHOLDS.reduceSizeConfFloor;
    const t = Math.max(0, Math.min(1,
      (executionConfidence - CONSENSUS_THRESHOLDS.reduceSizeConfFloor) / span));
    const sizeMul = 0.25 + t * 0.5;
    reasons.unshift(
      `REDUCE_SIZE: confidence ${executionConfidence.toFixed(0)} or agreement ` +
      `${(directionAgreement * 100).toFixed(0)}% below EXECUTE thresholds`,
    );
    return finalize({
      verdict: "REDUCE_SIZE", direction,
      executionConfidence: Math.round(executionConfidence),
      directionAgreement, recommendedSizeMultiplier: round2(sizeMul),
      reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
    });
  }

  reasons.unshift(`WAIT: confidence ${executionConfidence.toFixed(0)} below floor ${CONSENSUS_THRESHOLDS.reduceSizeConfFloor}`);
  return finalize({
    verdict: "WAIT", direction,
    executionConfidence: Math.round(executionConfidence),
    directionAgreement, recommendedSizeMultiplier: 0,
    reasons, blockers, freshVotesCount, expiredVotesCount, perAgent, now,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function finalize(args: Omit<ConsensusResult, "decidedAt"> & { now: Date }): ConsensusResult {
  const { now, ...rest } = args;
  return { ...rest, decidedAt: now.toISOString() };
}

function prependCount(
  reasons: string[], fresh: number, expired: number, perAgent: PerAgentBreakdown[],
): string[] {
  const blocking = perAgent.filter((p) => p.fresh && p.blocking).map((p) => p.agent);
  return [
    `BLOCK: ${blocking.length} agent${blocking.length === 1 ? "" : "s"} blocking — ${blocking.join(", ")}`,
    `${fresh} fresh / ${expired} expired votes`,
    ...reasons,
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Convenience accessor for callers that just want the human label
export function verdictLabel(v: ConsensusResult["verdict"]): string {
  // Inlined to avoid the cyclic import via the types module
  const map: Record<ConsensusResult["verdict"], string> = {
    EXECUTE: "EXECUTE", WAIT: "WAIT", REDUCE_SIZE: "REDUCE SIZE",
    BLOCK: "BLOCK", MONITOR_ONLY: "MONITOR ONLY",
  };
  return map[v];
}

// Convenience: build the per-agent line for a given consensus result,
// keyed by agent. Useful for UI display alongside the verdict.
export function findAgentBreakdown(result: ConsensusResult, agent: AgentName): PerAgentBreakdown | null {
  return result.perAgent.find((p) => p.agent === agent) ?? null;
}
