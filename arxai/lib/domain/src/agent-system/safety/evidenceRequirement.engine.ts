// evidenceRequirement — every non-NEUTRAL vote must cite at least one
// sensor-derived fact. An opinion with no evidence is, by definition, not
// based on data and must be neutralised.

import type { AgentOutputContract } from "../contracts/agentContract.types";

export interface EvidenceRequirementCheck {
  agentId: string;
  agentName: string;
  enforced: boolean;             // true ⇒ vote was downgraded
  reason: string | null;
  beforeVote: string;
  afterVote: string;
}

export function enforceEvidenceRequirement(c: AgentOutputContract): {
  contract: AgentOutputContract;
  check: EvidenceRequirementCheck;
} {
  const isOpinion = c.vote !== "NEUTRAL";
  const noEvidence = c.evidence.length === 0;
  if (isOpinion && noEvidence) {
    return {
      contract: {
        ...c, vote: "NEUTRAL", confidence01: 0,
        warnings: [...c.warnings, "[evidence-req] no evidence cited; downgraded to NEUTRAL"],
        uncertaintyReason: "no evidence cited",
      },
      check: {
        agentId: c.agentId, agentName: c.agentName, enforced: true,
        reason: "non-NEUTRAL vote with empty evidence list",
        beforeVote: c.vote, afterVote: "NEUTRAL",
      },
    };
  }
  return {
    contract: c,
    check: {
      agentId: c.agentId, agentName: c.agentName, enforced: false,
      reason: null, beforeVote: c.vote, afterVote: c.vote,
    },
  };
}
