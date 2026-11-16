// hardBlockResolver — resolve any authority-5 vetoes into a definitive
// HARD_BLOCK that overrides confidence and any softer verdict from the
// debate / judge layer.
//
// Invariants:
//   • If ANY authority-5 agent vetoed, finalVerdict = HARD_BLOCK and
//     confidence is irrelevant to the outcome.
//   • Multiple hard-blockers are all listed (transparency).

import type { CouncilVerdict } from "../agentVote.types";
import type { AuthorityDecision } from "../authority/agentAuthority.types";

export interface HardBlockResolution {
  triggered: boolean;
  byAgentIds: string[];
  byAgentNames: string[];
  overrodeConfidence: boolean;
  overrodeVerdict: CouncilVerdict | null; // the verdict that was overridden
  finalVerdict: CouncilVerdict | null;
  reason: string;
}

export function resolveHardBlock(args: {
  authorityDecisions: ReadonlyArray<AuthorityDecision>;
  currentVerdict: CouncilVerdict;
  currentConfidence01: number;
}): HardBlockResolution {
  const effective = args.authorityDecisions.filter(a => a.vetoEffective);
  if (effective.length === 0) {
    return {
      triggered: false, byAgentIds: [], byAgentNames: [],
      overrodeConfidence: false, overrodeVerdict: null,
      finalVerdict: null,
      reason: "no authority-5 veto",
    };
  }
  const overrode = args.currentVerdict !== "HARD_BLOCK";
  const overrodeConfidence = overrode && args.currentConfidence01 >= 0.55;
  return {
    triggered: true,
    byAgentIds: effective.map(a => a.agentId),
    byAgentNames: effective.map(a => a.agentName),
    overrodeConfidence,
    overrodeVerdict: overrode ? args.currentVerdict : null,
    finalVerdict: "HARD_BLOCK",
    reason: overrode
      ? `authority-5 veto by ${effective.map(a => a.agentName).join(", ")} overrides ${args.currentVerdict}` +
        (overrodeConfidence ? ` (confidence ${(args.currentConfidence01 * 100).toFixed(0)}% ignored)` : "")
      : `authority-5 veto by ${effective.map(a => a.agentName).join(", ")} confirms HARD_BLOCK`,
  };
}
