import { z } from "zod/v4";
import { AuthoritySchema, type Authority, authorityRank } from "./authorityHierarchy.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Governance Voting — weighted vote tally for non-emergency policy changes.
// Voter weight = INVERSE of hierarchy rank (higher authorities count more)
// AND is multiplied by reputation01 so untrusted authorities count less.
// ═══════════════════════════════════════════════════════════════════════════

export const VoteSchema = z.object({
  voter: AuthoritySchema,
  reputation01: z.number().min(0).max(1),
  ballot: z.enum(["YES", "NO", "ABSTAIN"]),
});
export type Vote = z.infer<typeof VoteSchema>;

export const GovernanceVoteInputsSchema = z.object({
  motion: z.string().min(1),
  votes: z.array(VoteSchema).min(1),
  approvalThreshold01: z.number().min(0.5).max(1).default(0.66),
});
export type GovernanceVoteInputs = z.infer<typeof GovernanceVoteInputsSchema>;

export interface GovernanceVoteResult {
  motion: string;
  passed: boolean;
  yesWeight: number;
  noWeight: number;
  totalWeight: number;
  approval01: number;
  perVoter: { voter: Authority; weight: number; ballot: Vote["ballot"] }[];
  reasons: string[];
}

export function tallyGovernanceVote(i: GovernanceVoteInputs): GovernanceVoteResult {
  // Weight = (max_rank - rank + 1) * reputation01.
  const maxRank = 6;
  let yes = 0, no = 0, total = 0;
  const perVoter = i.votes.map((v) => {
    const baseWeight = (maxRank - authorityRank(v.voter) + 1);
    const weight = baseWeight * v.reputation01;
    if (v.ballot === "YES") yes += weight;
    else if (v.ballot === "NO") no += weight;
    if (v.ballot !== "ABSTAIN") total += weight;
    return { voter: v.voter, weight, ballot: v.ballot };
  });
  const approval01 = total === 0 ? 0 : yes / total;
  const passed = approval01 >= i.approvalThreshold01;
  return {
    motion: i.motion,
    passed,
    yesWeight: yes,
    noWeight: no,
    totalWeight: total,
    approval01,
    perVoter,
    reasons: [
      `motion "${i.motion}" — yesWeight=${yes.toFixed(2)}, noWeight=${no.toFixed(2)}, approval=${approval01.toFixed(3)} vs threshold ${i.approvalThreshold01}`,
      passed ? "PASSED" : "REJECTED",
    ],
  };
}
