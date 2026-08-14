// Phase 3 upgrade — Agent Authority levels.
//
// Every agent has an authority level on a 1..5 scale that governs how
// strongly its vote can shape the final council verdict.
//
//   5 — may HARD_BLOCK on its own. Reserved for agents whose domain is
//       safety-critical: risk caps, execution health, news blackouts, and
//       Trader DNA (the strategy-fit gate).
//   4 — high authority: directional / structural agents. Their votes drive
//       the proposed direction and can force WAIT/SOFT_BLOCK in aggregate.
//   3 — mid authority: regime / quality gates whose vote weights setup
//       quality but cannot block on its own.
//   2 — advisory: precision and historical-similarity agents. They tilt
//       confidence but never block.
//   1 — informational only (reserved for future telemetry-only agents).

export type AuthorityLevel = 1 | 2 | 3 | 4 | 5;

/** Canonical authority assignment per agent id. */
export const AGENT_AUTHORITY: Record<string, AuthorityLevel> = {
  // ── Authority 5 — may hard block ──
  RISK: 5,
  EXEC: 5,
  NEWS: 5,
  DNA: 5,
  // ── Authority 4 — direction agents ──
  TREND: 4,
  MOMO: 4,
  LIQ: 4,
  STRUCT: 4,
  // ── Authority 3 — regime / quality gates ──
  VOL: 3,
  SESSION: 3,
  // ── Authority 2 — advisory quality ──
  PRECISION: 2,
  HIST: 2,
};

/** Returns the authority level for an agent id, defaulting to 1
 *  (informational-only) for unknown ids. */
export function authorityOf(agentId: string): AuthorityLevel {
  return AGENT_AUTHORITY[agentId] ?? 1;
}

/** True when the agent is allowed to drive a HARD_BLOCK on its own. */
export function canHardBlock(agentId: string): boolean {
  return authorityOf(agentId) === 5;
}

/** Per-agent authority decision artifact for one council run. */
export interface AuthorityDecision {
  agentId: string;
  agentName: string;
  authorityLevel: AuthorityLevel;
  canHardBlock: boolean;
  hadVeto: boolean;
  vetoEffective: boolean;             // veto AND authorityLevel === 5
  downgradedTo: "SOFT_BLOCK" | null;  // veto from non-5 agent → soft
  reason: string;
}
