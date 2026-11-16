import {
  type SessionContext, type SessionPriority, type RiskBudget, clamp01,
} from "./portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Session Priority — composite [0,1] over (recentExpectancy via tanh,
// recentWinRate, liquidity). Per-session cap = priority × perSessionCapR.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_SESSION_WEIGHTS = {
  performance: 0.45,
  winRate:     0.25,
  liquidity:   0.30,
} as const;
export type SessionWeights = typeof DEFAULT_SESSION_WEIGHTS;

export function computeSessionPriorities(
  sessions: ReadonlyArray<SessionContext>,
  riskBudget: RiskBudget,
  weights: SessionWeights = DEFAULT_SESSION_WEIGHTS,
): ReadonlyArray<SessionPriority> {
  const wSum = weights.performance + weights.winRate + weights.liquidity;
  return sessions.map((s) => {
    const reasons: string[] = [];
    const perfTanh = (Math.tanh(s.recentExpectancyR) + 1) / 2;
    const raw =
        perfTanh                  * weights.performance
      + clamp01(s.recentWinRate01)* weights.winRate
      + clamp01(s.liquidity01)    * weights.liquidity;
    const priority01 = clamp01(wSum > 0 ? raw / wSum : 0);
    const capR = priority01 * riskBudget.perSessionCapR;
    reasons.push(
      `perfTanh ${perfTanh.toFixed(2)} · winRate ${s.recentWinRate01.toFixed(2)} · liq ${s.liquidity01.toFixed(2)} → ${priority01.toFixed(3)}`);
    reasons.push(`capR ${capR.toFixed(2)}`);
    return { session: s.session, priority01, capR, reasons };
  });
}
