import {
  type AgentCascadeInput, type DirectionVerdict, type Level2Result, type TradeDirection,
  AGENT_CASCADE_THRESHOLDS,
} from "./agentCascade.types";

// ── Level 2 — Direction Agents ────────────────────────────────────────────
//
// Each agent independently votes BUY / SELL / ABSTAIN with a conviction
// 0..100. The level runner derives a consensus direction by majority among
// non-abstaining agents that meet the minimum-conviction floor.

// ── Trend Agent ───────────────────────────────────────────────────────────
//
// Votes from the longer-term trend bias. trendBiasSigned ∈ [-1, +1].
// Stronger absolute value = stronger conviction.
export function evaluateTrendAgent(input: AgentCascadeInput): DirectionVerdict {
  const reasons: string[] = [];
  const bias = input.priceContext.trendBiasSigned;
  let direction: DirectionVerdict["direction"];
  let conviction: number;

  if (bias >= 0.2) {
    direction = "BUY";
    conviction = clamp(bias * 100, 30, 100);
    reasons.push(`trend bias +${bias.toFixed(2)} → BUY @ ${conviction.toFixed(0)}`);
  } else if (bias <= -0.2) {
    direction = "SELL";
    conviction = clamp(Math.abs(bias) * 100, 30, 100);
    reasons.push(`trend bias ${bias.toFixed(2)} → SELL @ ${conviction.toFixed(0)}`);
  } else {
    direction = "ABSTAIN";
    conviction = 0;
    reasons.push(`trend bias ${bias.toFixed(2)} too flat to commit — abstain`);
  }

  return { agentId: "L2.TREND", agentName: "Trend Agent", direction, conviction, reasons };
}

// ── Momentum Agent ────────────────────────────────────────────────────────
//
// Votes from short-term signed momentum. Sign = direction; magnitude = conviction.
export function evaluateMomentumAgent(input: AgentCascadeInput): DirectionVerdict {
  const reasons: string[] = [];
  const m = input.priceContext.momentumSigned;
  let direction: DirectionVerdict["direction"];
  let conviction: number;

  const mag = Math.min(Math.abs(m), 1) * 100;
  if (m >= 0.15) {
    direction = "BUY";
    conviction = clamp(mag, 30, 100);
    reasons.push(`momentum +${m.toFixed(2)} → BUY @ ${conviction.toFixed(0)}`);
  } else if (m <= -0.15) {
    direction = "SELL";
    conviction = clamp(mag, 30, 100);
    reasons.push(`momentum ${m.toFixed(2)} → SELL @ ${conviction.toFixed(0)}`);
  } else {
    direction = "ABSTAIN";
    conviction = 0;
    reasons.push(`momentum ${m.toFixed(2)} too weak to commit — abstain`);
  }

  return { agentId: "L2.MOMO", agentName: "Momentum Agent", direction, conviction, reasons };
}

// ── Structure Agent ───────────────────────────────────────────────────────
//
// Votes from the most-recent break-of-structure direction. If no recent BOS
// is recorded, the agent abstains rather than guess.
export function evaluateStructureAgent(input: AgentCascadeInput): DirectionVerdict {
  const reasons: string[] = [];
  const bos = input.priceContext.recentStructureBreak;
  if (bos === null) {
    reasons.push("no recent break of structure — abstain");
    return { agentId: "L2.STRUCT", agentName: "Structure Agent", direction: "ABSTAIN", conviction: 0, reasons };
  }
  reasons.push(`recent BOS to the ${bos} side → vote ${bos} @ 70`);
  return { agentId: "L2.STRUCT", agentName: "Structure Agent", direction: bos, conviction: 70, reasons };
}

// ── Liquidity Agent ───────────────────────────────────────────────────────
//
// Votes from where unswept liquidity sits. Trades typically move TOWARD
// unswept liquidity (stop-runs / sweeps) — so unsweptLiquiditySide = BUY
// means there's liquidity ABOVE current price and price is likely to seek
// it; the agent votes BUY. Symmetric for SELL. If no clear pool, abstain.
export function evaluateLiquidityAgent(input: AgentCascadeInput): DirectionVerdict {
  const reasons: string[] = [];
  const side = input.priceContext.unsweptLiquiditySide;
  if (side === null) {
    reasons.push("no clear unswept liquidity pool — abstain");
    return { agentId: "L2.LIQ", agentName: "Liquidity Agent", direction: "ABSTAIN", conviction: 0, reasons };
  }
  reasons.push(`unswept liquidity to the ${side} side → vote ${side} @ 60 (sweep continuation)`);
  return { agentId: "L2.LIQ", agentName: "Liquidity Agent", direction: side, conviction: 60, reasons };
}

// ── Level runner ──────────────────────────────────────────────────────────
//
// Aggregates the four direction votes into a single consensus.
//   • Agents with conviction < minConvictionForVote are treated as abstaining.
//   • consensusDirection = majority among the remaining; "NONE" on tie or
//     when fewer than minAgreementForConsensus01 fraction agree.
//   • agreement01 = agreeingCount / totalNonAbstainingCount
//   • averageConviction = mean conviction among the agents that agreed
//     with the consensus direction (NaN-safe: returns 0 when no agreement).
export function runLevel2(input: AgentCascadeInput): Level2Result {
  const T = AGENT_CASCADE_THRESHOLDS.level2;
  const verdicts = [
    evaluateTrendAgent(input),
    evaluateMomentumAgent(input),
    evaluateStructureAgent(input),
    evaluateLiquidityAgent(input),
  ];

  // Filter out effective abstentions
  const voting = verdicts.filter((v) => v.direction !== "ABSTAIN" && v.conviction >= T.minConvictionForVote);

  if (voting.length === 0) {
    return { verdicts, consensusDirection: "NONE", agreement01: 0, averageConviction: 0 };
  }

  const buyCount = voting.filter((v) => v.direction === "BUY").length;
  const sellCount = voting.filter((v) => v.direction === "SELL").length;

  let consensusDirection: TradeDirection | "NONE";
  if (buyCount > sellCount) consensusDirection = "BUY";
  else if (sellCount > buyCount) consensusDirection = "SELL";
  else consensusDirection = "NONE";

  if (consensusDirection === "NONE") {
    return { verdicts, consensusDirection, agreement01: 0, averageConviction: 0 };
  }

  const agreeing = voting.filter((v) => v.direction === consensusDirection);
  const agreement01 = agreeing.length / voting.length;

  if (agreement01 < T.minAgreementForConsensus01) {
    return { verdicts, consensusDirection: "NONE", agreement01, averageConviction: 0 };
  }

  const averageConviction = agreeing.reduce((s, v) => s + v.conviction, 0) / agreeing.length;
  return { verdicts, consensusDirection, agreement01, averageConviction };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
