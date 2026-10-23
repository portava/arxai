// Agent Ecosystem — Layer 3 Traffic Controller (PURE).
//
// PURPOSE
//   Speed protection. Decide WHICH agents participate in a given decision so the
//   governance review stays cheap: not every agent runs on every action, only the
//   relevant ones, and light UI explanations get a lighter review than high-impact
//   decisions. This is pure participant SELECTION — it returns the subset of agents
//   to score plus a summary. It performs no work itself and adds no latency.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / SHADOW ONLY. Selecting participants never gates execution; the
//     live/demo path never waits on this — callers run it off the hot path on an
//     already-cached registry snapshot.
//   - PURE: deterministic, no I/O, no clock, no DB.
//   - Selection never INVENTS influence: a pure-shadow agent (authorityWeight 0)
//     stays weightless even if selected; it is included only so the trace can show
//     it was considered.

import type { AdvisoryAgentSnapshot } from "../advisory/agentAdvisory.engine";
import type { GovernanceImportance, TrafficSelectionSummary } from "./agentCourt.engine";

/** Departments that are relevant to each governance surface. */
const SURFACE_DEPARTMENTS: Record<string, readonly string[]> = {
  SCANNER: ["MARKET_STRUCTURE", "ENTRY", "EXECUTION", "RISK", "SCANNER", "NEWS"],
  RISK: ["MARKET_STRUCTURE", "ENTRY", "EXECUTION", "RISK", "SCANNER", "NEWS", "EXIT"],
  SCALP: ["SCALP", "RISK"],
};

/** Operations agents only join HIGH-importance reviews (they watch the system, not the signal). */
const OPERATIONS_DEPARTMENT = "AGENT_OPERATIONS";

/** Cap on participants for light (LOW importance) decisions. */
const LOW_IMPORTANCE_CAP = 3;
const MEDIUM_IMPORTANCE_CAP = 6;

function relevantDepartments(surface: string): readonly string[] {
  return SURFACE_DEPARTMENTS[surface] ?? [];
}

export interface TrafficSelectionInput {
  surface: string;
  importance: GovernanceImportance;
  agents: readonly AdvisoryAgentSnapshot[];
  /** Effective influence per agent (authorityWeight × status multiplier), 0-1. */
  effectiveInfluence: (a: AdvisoryAgentSnapshot) => number;
}

export interface TrafficSelectionResult {
  participants: AdvisoryAgentSnapshot[];
  summary: TrafficSelectionSummary;
}

/**
 * Select the agents that should participate in this decision. HIGH importance =
 * every relevant agent (plus operations agents). MEDIUM/LOW = capped to the most
 * influential relevant agents, so light reads do less work. Pure-shadow agents are
 * kept out of the participation count (they contribute 0) but reported as considered.
 */
export function selectParticipants(input: TrafficSelectionInput): TrafficSelectionResult {
  const { surface, importance, agents, effectiveInfluence } = input;
  const rel = relevantDepartments(surface);

  const considered = agents.filter((a) => {
    if (rel.includes(a.department)) return true;
    // Operations agents only weigh in on HIGH-importance decisions.
    if (a.department === OPERATIONS_DEPARTMENT && importance === "HIGH") return true;
    return false;
  });

  // Influential first, so any cap keeps the agents that actually matter.
  const ranked = [...considered].sort((a, b) => effectiveInfluence(b) - effectiveInfluence(a));

  let participants: AdvisoryAgentSnapshot[];
  if (importance === "HIGH") {
    participants = ranked;
  } else if (importance === "MEDIUM") {
    participants = ranked.slice(0, MEDIUM_IMPORTANCE_CAP);
  } else {
    participants = ranked.slice(0, LOW_IMPORTANCE_CAP);
  }

  const consideredCount = considered.length;
  const participatedCount = participants.length;
  const limited = participatedCount < consideredCount;

  return {
    participants,
    summary: {
      limited,
      consideredCount,
      participatedCount,
      reason: limited
        ? `light_review_for_${importance.toLowerCase()}_importance`
        : `full_review_for_${importance.toLowerCase()}_importance`,
    },
  };
}
