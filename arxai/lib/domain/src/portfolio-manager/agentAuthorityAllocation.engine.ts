import {
  type AgentContext, type AgentAuthority, clamp01,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Agent Authority Allocation — assign vote weights per agent based on
// calibration + track record + recent accuracy. Frozen agents get
// voteWeight = 0 with a structured blocker. Weights are normalised so the
// active cohort sums to 1 (frozen agents excluded from the normaliser).
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_AGENT_WEIGHTS = {
  calibration:    0.40,
  trackRecord:    0.35,
  recentAccuracy: 0.25,
} as const;
export type AgentWeights = typeof DEFAULT_AGENT_WEIGHTS;

export function allocateAgentAuthority(
  agents: ReadonlyArray<AgentContext>,
  weights: AgentWeights = DEFAULT_AGENT_WEIGHTS,
): ReadonlyArray<AgentAuthority> {
  const wSum = weights.calibration + weights.trackRecord + weights.recentAccuracy;
  // First pass — raw scores, frozen → 0.
  const raw = agents.map((a) => {
    const reasons: string[] = [];
    const blockers: string[] = [];
    if (a.isFrozen) {
      blockers.push(`agent ${a.agentId} is FROZEN — voteWeight forced to 0`);
      return { agentId: a.agentId, score: 0, reasons, blockers };
    }
    const r =
        clamp01(a.calibration01)    * weights.calibration
      + clamp01(a.trackRecord01)    * weights.trackRecord
      + clamp01(a.recentAccuracy01) * weights.recentAccuracy;
    const score = clamp01(wSum > 0 ? r / wSum : 0);
    reasons.push(
      `calibration ${a.calibration01.toFixed(2)} · trackRecord ${a.trackRecord01.toFixed(2)} · recent ${a.recentAccuracy01.toFixed(2)} → ${score.toFixed(3)}`);
    return { agentId: a.agentId, score, reasons, blockers };
  });
  const sum = raw.reduce((s, r) => s + r.score, 0);
  return raw.map((r) => ({
    agentId: r.agentId,
    voteWeight01: clamp01(sum > 0 ? r.score / sum : 0),
    reasons: [...r.reasons, sum > 0 ? `normalised by cohort sum ${sum.toFixed(3)}` : `cohort sum 0 — zero authority`],
    blockers: r.blockers,
  }));
}
