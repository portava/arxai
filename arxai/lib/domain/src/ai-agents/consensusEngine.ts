import {
  ALL_AGENTS, DEFAULT_AGENT_WEIGHTS,
  type AgentVote, type AiAgentContext, type AiAgentName,
  type AgentVoteKind, type AgentWeightProfile, type ConsensusResult,
  type AiReplayRecord, type MarketDangerResult,
} from "./aiAgents.types";
import { trendAI       } from "./trendAI.engine";
import { momentumAI    } from "./momentumAI.engine";
import { liquidityAI   } from "./liquidityAI.engine";
import { volatilityAI  } from "./volatilityAI.engine";
import { sessionAI     } from "./sessionAI.engine";
import { executionAI   } from "./executionAI.engine";
import { riskAI        } from "./riskAI.engine";
import { traderDnaAI   } from "./traderDNAAI.engine";
import { macroAI       } from "./macroAI.engine";
import { patternAI     } from "./patternAI.engine";

// All agents are pure functions — voting in parallel is just `.map()`.
const AGENT_FNS: Record<AiAgentName, (ctx: AiAgentContext) => AgentVote> = {
  trendAI, momentumAI, liquidityAI, volatilityAI, sessionAI,
  executionAI, riskAI, traderDnaAI, macroAI, patternAI,
};

const APPROVAL_FLOOR = 70;   // weighted execution confidence threshold

export interface ConsensusInput {
  ctx: AiAgentContext;
  weightProfile?: AgentWeightProfile | null;  // dynamic per strategy/regime
  marketDanger?: MarketDangerResult | null;   // injected — can force BLOCK
}

export function runConsensus(input: ConsensusInput): ConsensusResult {
  const { ctx, weightProfile, marketDanger } = input;
  const startedAt = (ctx.now ?? new Date()).getTime();
  const t0 = Date.now();

  // 1. Independent votes — never let any agent see another's vote
  const votes: AgentVote[] = ALL_AGENTS.map((name) => AGENT_FNS[name](ctx));

  // 2. Resolve weights — profile overrides defaults; missing keys fall back
  const weights = resolveWeights(weightProfile);

  // 3. Veto-blockers come first — any veto = consensus BLOCK regardless of weight
  const vetoBlockers: string[] = votes.filter((v) => v.vetoBlock).map(formatBlocker);

  // 4. Weighted execution confidence (BLOCK contributes 0, WAIT contributes half)
  let totalWeight = 0;
  let weightedSum = 0;
  for (const v of votes) {
    const w = weights[v.agent];
    totalWeight += w;
    if      (v.vote === "EXECUTE") weightedSum += w * v.confidence;
    else if (v.vote === "WAIT")    weightedSum += w * (v.confidence * 0.5);
    // BLOCK contributes 0
  }
  let executionConfidence = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // 5. Market danger override — can force the consensus to BLOCK regardless
  const dangerOverride = marketDanger?.shouldOverride === true;
  if (dangerOverride) {
    executionConfidence = Math.min(executionConfidence, 30);
  }

  // 6. Final consensus vote
  let consensusVote: AgentVoteKind;
  if (vetoBlockers.length > 0 || dangerOverride) {
    consensusVote = "BLOCK";
  } else if (executionConfidence >= APPROVAL_FLOOR) {
    consensusVote = "EXECUTE";
  } else if (executionConfidence >= 50) {
    consensusVote = "WAIT";
  } else {
    consensusVote = "BLOCK";
  }

  // 7. Agreement metric — share of agents voting the consensus direction
  const agreement = votes.filter((v) => v.vote === consensusVote).length / votes.length;

  // 8. Aggregate non-veto blockers as warnings (visible but non-fatal)
  const blockers: string[] = [...vetoBlockers];
  if (dangerOverride && marketDanger) {
    blockers.push(`[marketDanger] ${marketDanger.level} (${marketDanger.dangerScore}) — ${marketDanger.reasons.join("; ")}`);
  }
  const warnings: string[] = votes
    .filter((v) => v.vote === "BLOCK" && !v.vetoBlock)
    .map((v) => `[${v.agent}] ${v.reasoning}`);

  return {
    executionConfidence,
    consensusVote,
    blockers,
    warnings,
    votes,
    weights,
    agreement,
    signalId: String(ctx.signal.id),
    decidedAt: new Date(startedAt + (Date.now() - t0)).toISOString(),
    totalDurationMs: Date.now() - t0,
  };
}

function resolveWeights(profile: AgentWeightProfile | null | undefined): Record<AiAgentName, number> {
  const out = { ...DEFAULT_AGENT_WEIGHTS };
  if (!profile) return out;
  for (const a of ALL_AGENTS) {
    if (profile.weights[a] != null && Number.isFinite(profile.weights[a])) {
      out[a] = profile.weights[a];
    }
  }
  return out;
}

function formatBlocker(v: AgentVote): string {
  return `[${v.agent}][VETO] ${v.reasoning}`;
}

// ── Replay record — every consensus decision stored for AI learning ────────
export function buildReplayRecord(result: ConsensusResult, ctx: AiAgentContext): AiReplayRecord {
  return {
    signalId: result.signalId,
    decidedAt: result.decidedAt,
    consensusVote: result.consensusVote,
    executionConfidence: result.executionConfidence,
    contextFingerprint: fingerprint(ctx),
    result,
    outcomeR: null,
    outcomeRecordedAt: null,
    audit: null,
  };
}

export function fillReplayOutcome(
  record: AiReplayRecord, outcomeR: number, audit: unknown, now: Date = new Date(),
): AiReplayRecord {
  return { ...record, outcomeR, outcomeRecordedAt: now.toISOString(), audit };
}

function fingerprint(ctx: AiAgentContext): string {
  const parts = [
    `sig:${ctx.signal.id}`,
    `sym:${ctx.signal.symbol}`,
    `dir:${ctx.signal.direction ?? "-"}`,
    `conf:${ctx.signal.confidence}`,
    `regime:${ctx.marketSnapshot.regime?.regime ?? "?"}`,
    `strat:${ctx.strategyStats.strategyName}`,
    `vol:${ctx.volatility.current.toFixed(0)}`,
    `sess:${ctx.session.current}`,
  ];
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${s}`;
}
