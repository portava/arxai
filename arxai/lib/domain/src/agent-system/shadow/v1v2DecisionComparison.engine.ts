// v1v2DecisionComparison — compares a legacy V1 decision (verdict +
// confidence) against the new V2 council decision. Used by the shadow
// runner to flag situations where the new council disagrees with the
// legacy logic, so the team can audit before fully cutting over.

import type { CouncilVerdict } from "../agentVote.types";

export interface V1Decision {
  verdict: CouncilVerdict;
  confidence01: number;
}

export type DisagreementSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface V1V2Comparison {
  agree: boolean;
  v1Verdict: CouncilVerdict;
  v2Verdict: CouncilVerdict;
  verdictsMatch: boolean;
  v1Confidence01: number;
  v2Confidence01: number;
  confidenceDelta01: number;     // v2 - v1
  severity: DisagreementSeverity;
  reason: string;
}

// Group verdicts by "intent" so that EXECUTE_REDUCED vs EXECUTE is a smaller
// diff than EXECUTE vs HARD_BLOCK.
const VERDICT_INTENT: Record<CouncilVerdict, "GO" | "PAUSE" | "STOP"> = {
  EXECUTE: "GO", REDUCE_SIZE: "GO", EXECUTE_IF: "GO",
  WAIT: "PAUSE", MONITOR_ONLY: "PAUSE",
  SOFT_BLOCK: "STOP", HARD_BLOCK: "STOP",
};

export function compareV1V2(v1: V1Decision, v2: V1Decision): V1V2Comparison {
  const verdictsMatch = v1.verdict === v2.verdict;
  const intentsMatch = VERDICT_INTENT[v1.verdict] === VERDICT_INTENT[v2.verdict];
  const confDelta = +(v2.confidence01 - v1.confidence01).toFixed(3);
  const absDelta = Math.abs(confDelta);

  let severity: DisagreementSeverity;
  let reason: string;
  if (verdictsMatch && absDelta < 0.10) {
    severity = "NONE"; reason = "verdicts match within 0.10 confidence";
  } else if (verdictsMatch) {
    severity = "LOW"; reason = `verdicts match but confidence diverges by ${absDelta.toFixed(2)}`;
  } else if (intentsMatch) {
    severity = "MEDIUM"; reason = `verdicts differ (${v1.verdict} vs ${v2.verdict}) but intent is the same`;
  } else {
    severity = "HIGH";  reason = `intent mismatch: V1=${VERDICT_INTENT[v1.verdict]} vs V2=${VERDICT_INTENT[v2.verdict]}`;
  }
  return {
    agree: severity === "NONE",
    v1Verdict: v1.verdict, v2Verdict: v2.verdict, verdictsMatch,
    v1Confidence01: v1.confidence01, v2Confidence01: v2.confidence01,
    confidenceDelta01: confDelta, severity, reason,
  };
}
