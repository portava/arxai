// hallucinationGuard — rejects high-confidence claims that aren't backed by
// at least 2 evidence cites. Confidence > 0.60 with < 2 cites is treated as
// a hallucinated opinion and forced down to NEUTRAL @ 0.

import type { AgentOutputContract } from "../contracts/agentContract.types";

const HIGH_CONFIDENCE_THRESHOLD = 0.60;
const MIN_EVIDENCE_FOR_HIGH_CONFIDENCE = 2;

export interface HallucinationCheck {
  agentId: string;
  agentName: string;
  rejected: boolean;
  reason: string | null;
  beforeConfidence01: number;
  beforeVote: string;
  evidenceCount: number;
}

export function enforceHallucinationGuard(c: AgentOutputContract): {
  contract: AgentOutputContract;
  check: HallucinationCheck;
} {
  if (c.confidence01 > HIGH_CONFIDENCE_THRESHOLD
      && c.evidence.length < MIN_EVIDENCE_FOR_HIGH_CONFIDENCE) {
    const reason = `confidence ${c.confidence01.toFixed(2)} requires ≥${MIN_EVIDENCE_FOR_HIGH_CONFIDENCE} evidence cites (found ${c.evidence.length})`;
    return {
      contract: {
        ...c,
        vote: "NEUTRAL",
        confidence01: 0,
        warnings: [...c.warnings, `[hallucination-guard] ${reason}`],
        uncertaintyReason: "hallucination guard: insufficient evidence for confidence level",
      },
      check: {
        agentId: c.agentId, agentName: c.agentName,
        rejected: true, reason,
        beforeConfidence01: c.confidence01, beforeVote: c.vote,
        evidenceCount: c.evidence.length,
      },
    };
  }
  return {
    contract: c,
    check: {
      agentId: c.agentId, agentName: c.agentName,
      rejected: false, reason: null,
      beforeConfidence01: c.confidence01, beforeVote: c.vote,
      evidenceCount: c.evidence.length,
    },
  };
}
