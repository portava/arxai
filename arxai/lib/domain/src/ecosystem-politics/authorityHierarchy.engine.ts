import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Authority Hierarchy — strict, ordered list of authorities. Lower index =
// higher authority. Used to resolve who wins when two authorities disagree.
// PROJECT LAW L_KILL_SWITCH_OVERRIDE and L_RISK_GOVERNOR_FINAL anchor this.
// ═══════════════════════════════════════════════════════════════════════════

export const AuthoritySchema = z.enum([
  "KILL_SWITCH",
  "RISK_GOVERNOR",
  "CONTROL_TOWER",
  "GOVERNANCE_VOTE",
  "ECOSYSTEM_FITNESS",
  "STRATEGY_REPUTATION",
  "AGENT_REPUTATION",
]);
export type Authority = z.infer<typeof AuthoritySchema>;

export const HIERARCHY: readonly Authority[] = Object.freeze([
  "KILL_SWITCH",
  "RISK_GOVERNOR",
  "CONTROL_TOWER",
  "GOVERNANCE_VOTE",
  "ECOSYSTEM_FITNESS",
  "STRATEGY_REPUTATION",
  "AGENT_REPUTATION",
] as const);

export const ConflictInputsSchema = z.object({
  competing: z.array(AuthoritySchema).min(1),
  context: z.string().default(""),
});
export type ConflictInputs = z.infer<typeof ConflictInputsSchema>;

export interface ConflictResolution {
  winner: Authority;
  loser: Authority[];
  reasons: string[];
}

export function resolveAuthorityConflict(i: ConflictInputs): ConflictResolution {
  const ranked = [...i.competing].sort(
    (a, b) => HIERARCHY.indexOf(a) - HIERARCHY.indexOf(b),
  );
  const winner = ranked[0]!;
  const loser = ranked.slice(1);
  return {
    winner,
    loser,
    reasons: [
      `${i.competing.length} competing authorities — winner ${winner} (rank ${HIERARCHY.indexOf(winner)})`,
    ],
  };
}

export function authorityRank(a: Authority): number {
  return HIERARCHY.indexOf(a);
}
