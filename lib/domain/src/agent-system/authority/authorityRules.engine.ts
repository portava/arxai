// authorityRules — translate raw AgentVerdict[] into AuthorityDecision[].
// Pure function. No I/O.
//
// Rules:
//   • Every agent gets a decision row (12 in / 12 out).
//   • A veto from an authority-5 agent is "effective" — the council MUST
//     hard-block.
//   • A veto from any agent with authority <5 is downgraded to SOFT_BLOCK.
//   • Non-veto verdicts produce a NONE-style decision row noting the level.

import type { AgentVerdict, HardBlockVerdict } from "../agentSystem.types";
import {
  AGENT_AUTHORITY, authorityOf, type AuthorityDecision, type AuthorityLevel,
} from "./agentAuthority.types";

export function applyAuthorityRules(verdicts: AgentVerdict[]): AuthorityDecision[] {
  return verdicts.map((v) => {
    const level: AuthorityLevel = authorityOf(v.agentId);
    const canHard = level === 5;

    if (v.category === "HARD_BLOCK") {
      const b = v as HardBlockVerdict;
      if (b.vetoed) {
        if (canHard) {
          return {
            agentId: v.agentId, agentName: v.agentName,
            authorityLevel: level, canHardBlock: true,
            hadVeto: true, vetoEffective: true, downgradedTo: null,
            reason: `${v.agentName} (auth ${level}) vetoed — HARD_BLOCK enforceable`,
          };
        }
        return {
          agentId: v.agentId, agentName: v.agentName,
          authorityLevel: level, canHardBlock: false,
          hadVeto: true, vetoEffective: false, downgradedTo: "SOFT_BLOCK",
          reason: `${v.agentName} (auth ${level}) vetoed but lacks hard-block authority — downgraded to SOFT_BLOCK`,
        };
      }
    }
    return {
      agentId: v.agentId, agentName: v.agentName,
      authorityLevel: level, canHardBlock: canHard,
      hadVeto: false, vetoEffective: false, downgradedTo: null,
      reason: `${v.agentName} (auth ${level}) — no veto`,
    };
  });
}

/** Convenience: list all authority-5 agent ids known at startup. */
export function listAuthority5Agents(): string[] {
  return Object.entries(AGENT_AUTHORITY)
    .filter(([, lvl]) => lvl === 5).map(([id]) => id);
}
