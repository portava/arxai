import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Authority Reward — proposes WIDENING an agent's authority envelope.
//
// CRITICAL: This module proposes only. Actual authority changes flow
// through Control Tower → Risk Governor. This engine is the upstream
// "earn" gate; the Risk Governor still has final veto.
//
// Six gates must ALL pass to recommend a widen:
//   1. trustScore ≥ minTrust
//   2. discipline ≥ minDiscipline
//   3. survivalQuality ≥ minSurvival
//   4. sampleCount ≥ minSamples
//   5. recentDrawdownPct ≤ maxRecentDrawdown
//   6. zero authority breaches in evaluation window
// ═══════════════════════════════════════════════════════════════════════════

export const AuthorityRewardInputsSchema = z.object({
  agentId: z.string().min(1),
  trustScore01: z.number().min(0).max(1),
  discipline01: z.number().min(0).max(1),
  survivalQuality01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  recentDrawdownPct: z.number().min(0),
  authorityBreachesInWindow: z.int().nonnegative(),
});
export type AuthorityRewardInputs = z.infer<typeof AuthorityRewardInputsSchema>;

export const AuthorityRewardActionSchema = z.enum(["WIDEN_AUTHORITY", "HOLD"]);
export type AuthorityRewardAction = z.infer<typeof AuthorityRewardActionSchema>;

export const AUTHORITY_REWARD_GATES = {
  minTrust: 0.70,
  minDiscipline: 0.85,
  minSurvival: 0.75,
  minSamples: 200,
  maxRecentDrawdownPct: 8.0,
  // Defensive: any breach in window blocks widen.
  maxBreaches: 0,
} as const;

export interface AuthorityRewardDecision {
  action: AuthorityRewardAction;
  agentId: string;
  passedGates: string[];
  failedGates: string[];
  reasons: string[];
  blockers: string[];
}

export function evaluateAuthorityReward(i: AuthorityRewardInputs): AuthorityRewardDecision {
  const G = AUTHORITY_REWARD_GATES;
  const passed: string[] = [];
  const failed: string[] = [];
  const reasons: string[] = [];
  const blockers: string[] = [];

  check("trust",      i.trustScore01       >= G.minTrust,        `trust ${i.trustScore01.toFixed(3)} ≥ ${G.minTrust}`);
  check("discipline", i.discipline01       >= G.minDiscipline,   `discipline ${i.discipline01.toFixed(3)} ≥ ${G.minDiscipline}`);
  check("survival",   i.survivalQuality01  >= G.minSurvival,     `survival ${i.survivalQuality01.toFixed(3)} ≥ ${G.minSurvival}`);
  check("samples",    i.sampleCount        >= G.minSamples,      `samples ${i.sampleCount} ≥ ${G.minSamples}`);
  check("drawdown",   i.recentDrawdownPct  <= G.maxRecentDrawdownPct,
                      `recentDrawdown ${i.recentDrawdownPct.toFixed(2)}% ≤ ${G.maxRecentDrawdownPct}%`);
  check("breaches",   i.authorityBreachesInWindow <= G.maxBreaches,
                      `breaches ${i.authorityBreachesInWindow} ≤ ${G.maxBreaches}`);

  const action: AuthorityRewardAction = failed.length === 0 ? "WIDEN_AUTHORITY" : "HOLD";
  if (action === "WIDEN_AUTHORITY") {
    reasons.push(`all 6 widen gates passed — proposing WIDEN_AUTHORITY (Risk Governor still has final veto)`);
  } else {
    blockers.push(...failed.map((f) => `failed gate: ${f}`));
    reasons.push(`${failed.length}/6 gates failed — HOLD`);
  }
  return { action, agentId: i.agentId, passedGates: passed, failedGates: failed, reasons, blockers };

  function check(name: string, ok: boolean, detail: string): void {
    if (ok) { passed.push(name); reasons.push(`PASS ${name}: ${detail}`); }
    else    { failed.push(name); reasons.push(`FAIL ${name}: ${detail}`); }
  }
}
