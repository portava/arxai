// agentVote.types — Phase 3 council vocabulary.
//
// Defines the canonical 5-vote scale that each agent emits, the 7-verdict
// scale that the council Judge produces, and the supporting Red/Blue team
// debate shapes. Includes a small helper to map any of the existing
// AgentVerdict variants (HardBlock/Direction/Quality) onto the 5-vote scale
// so disagreement and judging code can treat all agents uniformly.

import { z } from "zod/v4";
import type { AgentVerdict, TradeDirection } from "./agentSystem.types";

// ── 5-vote scale (per-agent stance) ──────────────────────────────────────
export const AgentVoteSchema = z.enum([
  "STRONG_FOR",
  "FOR",
  "NEUTRAL",
  "AGAINST",
  "STRONG_AGAINST",
]);
export type AgentVote = z.infer<typeof AgentVoteSchema>;

// Numeric scalar in [-2..+2] for variance/aggregation maths.
export const AGENT_VOTE_SCALAR: Record<AgentVote, number> = {
  STRONG_FOR: 2,
  FOR: 1,
  NEUTRAL: 0,
  AGAINST: -1,
  STRONG_AGAINST: -2,
};

// ── 7-verdict council vocabulary ─────────────────────────────────────────
export const CouncilVerdictSchema = z.enum([
  "EXECUTE",
  "WAIT",
  "REDUCE_SIZE",
  "MONITOR_ONLY",
  "SOFT_BLOCK",
  "HARD_BLOCK",
  "EXECUTE_IF",
]);
export type CouncilVerdict = z.infer<typeof CouncilVerdictSchema>;

// ── Per-agent council vote (uniform shape) ───────────────────────────────
export interface AgentCouncilVote {
  agentId: string;
  agentName: string;
  domain: string;
  vote: AgentVote;
  confidence01: number;          // 0..1
  evidence: string[];            // why this vote
  blockers: string[];            // hard objections
  warnings: string[];            // soft cautions
  isCritical: boolean;           // critical = blocker → HARD_BLOCK
  expiresAtIso: string;          // when this opinion goes stale
}

// ── Red Team / Blue Team debate ──────────────────────────────────────────
export interface RedTeamChallenge {
  challengeId: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
  addressedAgentId: string | null;
  evidence: string[];
}
export interface RedTeamReport {
  challenges: RedTeamChallenge[];
  /** "no fault found" is still a valid outcome — every trade gets a
   *  challenge pass even if no concrete challenge is raised. */
  examined: true;
  summary: string;
}

export interface BlueTeamDefense {
  defenseId: string;
  strength: "WEAK" | "MEDIUM" | "STRONG";
  reason: string;
  supportingAgentId: string | null;
  evidence: string[];
}
/** A condition under which the trade should ONLY proceed.
 *  Non-empty conditions trigger an EXECUTE_IF council verdict. */
export interface BlueTeamCondition {
  conditionId: string;
  description: string;
  monitorSignal: string;        // what to watch for to satisfy it
}
export interface BlueTeamReport {
  defenses: BlueTeamDefense[];
  conditions: BlueTeamCondition[];
  examined: true;
  summary: string;
}

// ── Council decision (judge output in 7-verdict vocabulary) ──────────────
export interface CouncilDecision {
  verdict: CouncilVerdict;
  proposedDirection: TradeDirection | null;
  confidence01: number;
  sizeMultiplier: number;            // 0..1.5
  reasoning: string[];
  blockers: string[];
  warnings: string[];
  conditions: BlueTeamCondition[];   // non-empty only for EXECUTE_IF
}

// ── Judge explanation (human-readable summary) ───────────────────────────
export interface CouncilExplanation {
  headline: string;
  bullets: string[];
  cautionFlags: string[];
}

// ── Aggregate council artifact (everything one council run produces) ─────
// Phase 3 upgrade adds: authority decisions, vote-expiration checks, stale
// guard result, conflict severity classification, ranked blocker hierarchy,
// and the hard-block resolution overlay. All fields are required so callers
// always get a complete picture.
import type { AuthorityDecision } from "./authority/agentAuthority.types";
import type { VoteExpirationCheck } from "./expiration/voteExpiration.engine";
import type { StaleGuardResult } from "./expiration/staleDecisionGuard.engine";
import type { ConflictSeverityResult } from "./conflict/conflictSeverity.engine";
import type { RankedBlocker } from "./conflict/blockerHierarchy.engine";
import type { HardBlockResolution } from "./conflict/hardBlockResolver.engine";
import type { AgentOutputContract, ContractValidation } from "./contracts/agentContract.types";
import type { ConfidenceCapApplication } from "./safety/confidenceCap.engine";
import type { HallucinationCheck } from "./safety/hallucinationGuard.engine";
import type { EvidenceRequirementCheck } from "./safety/evidenceRequirement.engine";

export interface CouncilRunArtifact {
  decisionId: string;
  generatedAtIso: string;
  schemaVersion: string;          // contract schema version
  agentContracts: AgentOutputContract[];
  contractValidations: ContractValidation[];
  confidenceCaps: ConfidenceCapApplication[];
  hallucinationChecks: HallucinationCheck[];
  evidenceChecks: EvidenceRequirementCheck[];
  agentVotes: AgentCouncilVote[];
  authorityDecisions: AuthorityDecision[];
  voteExpirationChecks: VoteExpirationCheck[];
  staleGuard: StaleGuardResult;
  redTeam: RedTeamReport;
  blueTeam: BlueTeamReport;
  disagreementScore01: number;
  conflictSeverity: ConflictSeverityResult;
  decision: CouncilDecision;
  blockerHierarchy: RankedBlocker[];
  hardBlockResolution: HardBlockResolution;
  explanation: CouncilExplanation;
}

// ── Helper: map any AgentVerdict onto the 5-vote scale ───────────────────
export function verdictToCouncilVote(v: AgentVerdict, proposedDir: TradeDirection): {
  vote: AgentVote; confidence01: number;
} {
  if (v.category === "HARD_BLOCK") {
    if (v.vetoed) return { vote: "STRONG_AGAINST", confidence01: 1 };
    return { vote: "FOR", confidence01: 0.6 };
  }
  if (v.category === "DIRECTION") {
    if (v.direction === "ABSTAIN") return { vote: "NEUTRAL", confidence01: 0 };
    const aligned = v.direction === proposedDir;
    const c01 = Math.max(0, Math.min(1, v.conviction / 100));
    if (aligned) return { vote: c01 >= 0.7 ? "STRONG_FOR" : "FOR", confidence01: c01 };
    return { vote: c01 >= 0.7 ? "STRONG_AGAINST" : "AGAINST", confidence01: c01 };
  }
  // QUALITY
  const q = v.qualityScore;
  if (q >= 75) return { vote: "STRONG_FOR", confidence01: q / 100 };
  if (q >= 55) return { vote: "FOR", confidence01: q / 100 };
  if (q >= 45) return { vote: "NEUTRAL", confidence01: 0.5 };
  if (q >= 25) return { vote: "AGAINST", confidence01: (50 - q) / 50 };
  return { vote: "STRONG_AGAINST", confidence01: (50 - q) / 50 };
}

/** Critical agents whose blockers MUST escalate to HARD_BLOCK.
 *  Per Phase 3 upgrade: every authority-5 agent is critical, which now
 *  includes Trader DNA alongside risk / execution / news. */
export const CRITICAL_AGENT_IDS: ReadonlySet<string> = new Set([
  "RISK", "EXEC", "NEWS", "DNA",
]);
