// conflictSeverity — classify how divided the council is and, if the
// disagreement is severe enough, force a more restrictive verdict.
//
// Thresholds (using the disagreement score from disagreementScore.engine):
//   0.00 .. 0.30   NONE      — no escalation
//   0.30 .. 0.50   LOW       — warn only
//   0.50 .. 0.70   MEDIUM    — force WAIT
//   0.70 .. 0.90   HIGH      — force SOFT_BLOCK
//   0.90 .. 1.00   EXTREME   — force HARD_BLOCK

import type { CouncilVerdict } from "../agentVote.types";

export type ConflictSeverityLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export interface ConflictSeverityResult {
  level: ConflictSeverityLevel;
  disagreement01: number;
  forcedVerdict: CouncilVerdict | null;
  reason: string;
}

export function classifyConflict(
  disagreement01: number,
  conflictCount = 0,
): ConflictSeverityResult {
  const d = Math.max(0, Math.min(1, disagreement01));
  // Conflict count nudges severity up by half a band when many active conflicts.
  const adj = d + Math.min(0.1, conflictCount * 0.02);

  let level: ConflictSeverityLevel;
  let forcedVerdict: CouncilVerdict | null = null;

  if (adj >= 0.90)      { level = "EXTREME"; forcedVerdict = "HARD_BLOCK"; }
  else if (adj >= 0.70) { level = "HIGH";    forcedVerdict = "SOFT_BLOCK"; }
  else if (adj >= 0.50) { level = "MEDIUM";  forcedVerdict = "WAIT"; }
  else if (adj >= 0.30) { level = "LOW";     forcedVerdict = null; }
  else                  { level = "NONE";    forcedVerdict = null; }

  return {
    level, disagreement01: d, forcedVerdict,
    reason: forcedVerdict
      ? `${level} conflict (disagreement ${(d * 100).toFixed(0)}% + ${conflictCount} conflicts) → forced ${forcedVerdict}`
      : `${level} conflict (disagreement ${(d * 100).toFixed(0)}%, ${conflictCount} conflicts)`,
  };
}

/** Strictness ordering of council verdicts (low → high). Higher index = more
 *  restrictive. Used to decide whether a forced verdict should ESCALATE the
 *  current decision; we never DEgrade. */
export const VERDICT_STRICTNESS: Record<CouncilVerdict, number> = {
  EXECUTE: 0,
  EXECUTE_IF: 1,
  REDUCE_SIZE: 2,
  MONITOR_ONLY: 3,
  WAIT: 4,
  SOFT_BLOCK: 5,
  HARD_BLOCK: 6,
};

export function escalateIfMoreStrict(
  current: CouncilVerdict, forced: CouncilVerdict | null,
): CouncilVerdict {
  if (!forced) return current;
  return VERDICT_STRICTNESS[forced] > VERDICT_STRICTNESS[current] ? forced : current;
}
