// agentShadowRunner — runs the V2 council "in the shadow" of a V1 decision.
// V2 NEVER places trades from this path; the runner just exposes the V2
// artifact alongside a V1↔V2 comparison so the system can watch the new
// brain disagree with the old one and decide when to cut over.

import { runCouncil } from "../runCouncil";
import type { AgentSystemSnapshot } from "../agentSystem.types";
import type { CouncilRunArtifact } from "../agentVote.types";
import { compareV1V2, type V1Decision, type V1V2Comparison } from "./v1v2DecisionComparison.engine";

export interface ShadowRunResult {
  decisionId: string;
  generatedAtIso: string;
  v1: V1Decision;
  v2: { verdict: CouncilRunArtifact["decision"]["verdict"]; confidence01: number };
  v2Artifact: CouncilRunArtifact;
  comparison: V1V2Comparison;
  canPlaceTrades: false;          // hard invariant
}

export function runAgentShadow(
  snap: AgentSystemSnapshot,
  decisionId: string,
  v1: V1Decision,
): ShadowRunResult {
  const v2Artifact = runCouncil(snap, decisionId);
  const v2: V1Decision = {
    verdict: v2Artifact.decision.verdict,
    confidence01: v2Artifact.decision.confidence01,
  };
  return {
    decisionId,
    generatedAtIso: v2Artifact.generatedAtIso,
    v1, v2, v2Artifact,
    comparison: compareV1V2(v1, v2),
    canPlaceTrades: false,
  };
}
