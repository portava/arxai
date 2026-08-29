// Capability #49 — management-authority arbiter for one open position.
//
// The CAS layer (liveCommandCas.ts) SERIALIZES concurrent transitions of one
// command row, but it never ADJUDICATES: when a user's manual command and an
// automated strategy's command both claim management of the SAME open
// position, CAS just lets whichever UPDATE lands first win. This module is
// the explicit, deterministic arbiter for that contention.
//
// PRECEDENCE (fixed order, mirrors the safety spine):
//   1. RISK-REDUCTION DOMINANCE — a risk-reducing claim (close / tighten
//      protection) always outranks a non-risk-reducing claim, regardless of
//      source. Two risk-reducing claims: the earlier one proceeds (the later
//      duplicates work the broker will refuse anyway).
//   2. HUMAN DOMINANCE — the position owner's USER_COMMAND outranks an
//      AUTOMATED_STRATEGY claim. Automation NEVER displaces the human's
//      standing management of their own position ("AUTO authority changes
//      only REDUCE"). ADMIN_OPERATOR ranks with the human user (operator ops
//      commands already pass their own gates + audit).
//   3. FIRST-CLAIM PRIORITY — same rank on both sides: the earlier
//      `claimedAt` proceeds; exact ties break on lexicographic commandId
//      (both are total orders, so the outcome is deterministic).
//
// DEFAULT-DENY: an UNKNOWN source, a claim by a non-owner user, or an
// unparseable timestamp REFUSES that claim (and if both claims are refused,
// nobody wins — the position stays as it is and the caller must surface the
// contention to an operator). Ambiguity never resolves toward action.
//
// Pure and deterministic: no IO, no DB, no clock. The caller JOURNALS the
// returned record (append-only audit) — arbitration without a journal entry
// is not permitted by the wiring in liveCommandPipeline.

export type ManagementClaimSource =
  | "USER_COMMAND"
  | "AUTOMATED_STRATEGY"
  | "ADMIN_OPERATOR";

export interface ManagementClaim {
  /** Command id (used for journaling and the final deterministic tie-break). */
  commandId: string;
  /** Who authored the claim. Anything not in the vocabulary is refused. */
  source: string;
  /** The user the claim acts for (command row's userId). */
  actorUserId: number;
  /** True for close / protective-tighten claims (risk-reducing). */
  isRiskReducing: boolean;
  /** ISO-8601 instant the claim was made (draft/approval time). */
  claimedAt: string;
}

export type ClaimRefusalReason =
  | "SOURCE_UNKNOWN"
  | "ACTOR_NOT_POSITION_OWNER"
  | "CLAIMED_AT_UNPARSEABLE"
  | "COMMAND_ID_EMPTY";

export type ArbitrationRule =
  | "RISK_REDUCTION_DOMINANCE"
  | "HUMAN_DOMINANCE"
  | "FIRST_CLAIM_PRIORITY"
  | "SINGLE_VALID_CLAIM"
  | "NO_VALID_CLAIM";

export interface ArbitrationDecision {
  /** Which claim may proceed — null when neither is valid. */
  winner: "A" | "B" | null;
  /** The precedence rule that decided it. */
  rule: ArbitrationRule;
  /** Refusals, per claim (empty array = claim was valid). */
  refusalsA: ClaimRefusalReason[];
  refusalsB: ClaimRefusalReason[];
  /** Journal-ready record of the whole adjudication. */
  journal: {
    kind: "MANAGEMENT_AUTHORITY_ARBITRATION";
    positionOwnerUserId: number;
    claimA: ManagementClaim;
    claimB: ManagementClaim;
    winnerCommandId: string | null;
    rule: ArbitrationRule;
    refusalsA: ClaimRefusalReason[];
    refusalsB: ClaimRefusalReason[];
  };
}

const RANK: Record<ManagementClaimSource, number> = {
  USER_COMMAND: 2,
  ADMIN_OPERATOR: 2,
  AUTOMATED_STRATEGY: 1,
};

function isKnownSource(s: string): s is ManagementClaimSource {
  return s === "USER_COMMAND" || s === "AUTOMATED_STRATEGY" || s === "ADMIN_OPERATOR";
}

function validateClaim(
  claim: ManagementClaim,
  positionOwnerUserId: number,
): ClaimRefusalReason[] {
  const refusals: ClaimRefusalReason[] = [];
  if (typeof claim.commandId !== "string" || claim.commandId.trim() === "") {
    refusals.push("COMMAND_ID_EMPTY");
  }
  if (!isKnownSource(claim.source)) {
    refusals.push("SOURCE_UNKNOWN");
  } else if (claim.source !== "ADMIN_OPERATOR" && claim.actorUserId !== positionOwnerUserId) {
    // A user command or strategy claim must act for the position's owner.
    // ADMIN_OPERATOR acts on behalf of the platform (its own routes gate it).
    refusals.push("ACTOR_NOT_POSITION_OWNER");
  }
  if (!Number.isFinite(Date.parse(claim.claimedAt))) {
    refusals.push("CLAIMED_AT_UNPARSEABLE");
  }
  return refusals;
}

/** Deterministic earlier-claim comparison: claimedAt, then commandId. */
function aClaimedFirst(a: ManagementClaim, b: ManagementClaim): boolean {
  const ta = Date.parse(a.claimedAt);
  const tb = Date.parse(b.claimedAt);
  if (ta !== tb) return ta < tb;
  return a.commandId <= b.commandId;
}

/**
 * Arbitrate two claims over the same open position. Deterministic: identical
 * inputs always produce identical output, and swapping A/B swaps the winner
 * label but never the winning commandId.
 */
export function arbitrateManagementAuthority(
  claimA: ManagementClaim,
  claimB: ManagementClaim,
  positionOwnerUserId: number,
): ArbitrationDecision {
  const refusalsA = validateClaim(claimA, positionOwnerUserId);
  const refusalsB = validateClaim(claimB, positionOwnerUserId);
  const validA = refusalsA.length === 0;
  const validB = refusalsB.length === 0;

  let winner: "A" | "B" | null;
  let rule: ArbitrationRule;

  if (!validA && !validB) {
    winner = null;
    rule = "NO_VALID_CLAIM";
  } else if (validA !== validB) {
    winner = validA ? "A" : "B";
    rule = "SINGLE_VALID_CLAIM";
  } else if (claimA.isRiskReducing !== claimB.isRiskReducing) {
    // 1. Risk-reduction dominance.
    winner = claimA.isRiskReducing ? "A" : "B";
    rule = "RISK_REDUCTION_DOMINANCE";
  } else {
    const rankA = RANK[claimA.source as ManagementClaimSource];
    const rankB = RANK[claimB.source as ManagementClaimSource];
    if (rankA !== rankB) {
      // 2. Human dominance over automation.
      winner = rankA > rankB ? "A" : "B";
      rule = "HUMAN_DOMINANCE";
    } else {
      // 3. First claim proceeds (total order: claimedAt then commandId).
      winner = aClaimedFirst(claimA, claimB) ? "A" : "B";
      rule = "FIRST_CLAIM_PRIORITY";
    }
  }

  const winnerCommandId =
    winner === "A" ? claimA.commandId : winner === "B" ? claimB.commandId : null;

  return {
    winner,
    rule,
    refusalsA,
    refusalsB,
    journal: {
      kind: "MANAGEMENT_AUTHORITY_ARBITRATION",
      positionOwnerUserId,
      claimA,
      claimB,
      winnerCommandId,
      rule,
      refusalsA,
      refusalsB,
    },
  };
}

/**
 * Map an arx_live_commands actor_type (USER | ADMIN | OWNER |
 * SELF_TRADE_AGENT | SYSTEM) to a claim source. Unknown/null maps to the
 * literal string "UNKNOWN", which the arbiter REFUSES (default-deny) —
 * never coerced to a permissive source.
 */
export function claimSourceFromActorType(actorType: string | null | undefined): string {
  switch (actorType) {
    case "USER":
      return "USER_COMMAND";
    case "ADMIN":
    case "OWNER":
      return "ADMIN_OPERATOR";
    case "SELF_TRADE_AGENT":
    case "SYSTEM":
      return "AUTOMATED_STRATEGY";
    default:
      return "UNKNOWN";
  }
}
