import type { ConsensusResult as V1Result } from "../ai-agents/aiAgents.types";
import type { ConsensusResult as V2Result } from "../agents/consensusVerdict.types";
import type { ActionClass, DivergenceKind, ShadowComparison } from "./intelligenceV2.types";

const CONFIDENCE_DIVERGENCE_THRESHOLD = 15;   // |delta| > this = divergence

// Map both consensus systems onto a shared 3-state action class so
// disagreements are unambiguous regardless of vote vocabulary.
export function v1ActionClass(vote: V1Result["consensusVote"]): ActionClass {
  if (vote === "EXECUTE") return "ACTED";
  if (vote === "BLOCK")   return "BLOCKED";
  return "WAITED";
}

export function v2ActionClass(verdict: V2Result["verdict"]): ActionClass {
  if (verdict === "EXECUTE")      return "ACTED";
  if (verdict === "REDUCE_SIZE")  return "ACTED";       // still acts, just smaller size
  if (verdict === "BLOCK")        return "BLOCKED";
  // MONITOR_ONLY = "agents disagree on direction, track but don't trade".
  // It is an indecision, NOT a hard risk block — mapping it to BLOCKED
  // would inflate false-block / risk-avoidance metrics.
  if (verdict === "MONITOR_ONLY") return "WAITED";
  return "WAITED";
}

// runShadowComparison
//
// Pure: takes two already-computed consensus results and produces a
// structured comparison record. The caller is responsible for actually
// running both engines and feeding the results in — keeps this function
// independent of the engine entry-point signatures.
export interface RunShadowComparisonInput {
  signalId: string;
  v1: V1Result;
  v2: V2Result;
  now?: Date;
}

export function runShadowComparison(input: RunShadowComparisonInput): ShadowComparison {
  const { signalId, v1, v2 } = input;
  const now = input.now ?? new Date();

  const v1Class = v1ActionClass(v1.consensusVote);
  const v2Class = v2ActionClass(v2.verdict);
  const confidenceDelta = v2.executionConfidence - v1.executionConfidence;

  const divergenceKinds: DivergenceKind[] = [];
  const notes: string[] = [];

  if (v1Class !== v2Class) {
    divergenceKinds.push("VERDICT");
    notes.push(`action class differs: v1=${v1Class} (${v1.consensusVote}) vs v2=${v2Class} (${v2.verdict})`);
  }
  if (Math.abs(confidenceDelta) > CONFIDENCE_DIVERGENCE_THRESHOLD) {
    divergenceKinds.push("CONFIDENCE");
    notes.push(`confidence delta ${confidenceDelta.toFixed(0)} exceeds ${CONFIDENCE_DIVERGENCE_THRESHOLD}`);
  }
  if (!sameStringSet(v1.blockers, v2.blockers)) {
    divergenceKinds.push("BLOCKERS");
    const v1Only = v1.blockers.filter((b) => !v2.blockers.includes(b));
    const v2Only = v2.blockers.filter((b) => !v1.blockers.includes(b));
    if (v1Only.length > 0) notes.push(`v1-only blockers: ${v1Only.join(" | ")}`);
    if (v2Only.length > 0) notes.push(`v2-only blockers: ${v2Only.join(" | ")}`);
  }
  // v1 has no direction concept; surface v2's direction as informational
  // only — never as a divergence kind.
  if (v1Class === "ACTED" && v2Class === "ACTED" && v2.direction !== null) {
    notes.push(`v2 direction = ${v2.direction} (v1 has no direction)`);
  }

  if (divergenceKinds.length === 0) divergenceKinds.push("NONE");

  return {
    signalId, comparedAt: now.toISOString(),
    v1Vote: v1.consensusVote,
    v1Confidence: v1.executionConfidence,
    v1ActionClass: v1Class,
    v1Blockers: v1.blockers,
    v2Verdict: v2.verdict,
    v2Confidence: v2.executionConfidence,
    v2ActionClass: v2Class,
    v2Direction: v2.direction,
    v2Blockers: v2.blockers,
    v2RecommendedSizeMultiplier: v2.recommendedSizeMultiplier,
    agreed: divergenceKinds.length === 1 && divergenceKinds[0] === "NONE",
    divergenceKinds,
    confidenceDelta,
    notes,
  };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const s of b) if (!sa.has(s)) return false;
  return true;
}
