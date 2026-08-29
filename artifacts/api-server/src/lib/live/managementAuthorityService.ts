// Capability #49 — management-authority contention check for live dispatch.
//
// CAS (liveCommandCas.ts) serializes concurrent writes to ONE command row; it
// never adjudicates two DIFFERENT commands claiming management of the same
// open position (a user's manual MODIFY racing an automated strategy's
// MODIFY, a strategy trying to re-manage a position the user just claimed).
// This service finds that contention at dispatch time, runs the pure,
// deterministic arbiter (@workspace/domain live-position/managementAuthority)
// and returns a typed verdict the pipeline enforces.
//
// SAFETY:
//   * REFUSE-ONLY. This check can only block the INCOMING command; it never
//     cancels, replaces, or dispatches anything. No new execution path.
//   * RISK-REDUCTION IS NEVER TRAPPED. An incoming CLOSE (risk-reducing) is
//     never blocked here — if the arbiter ranks an existing claim above it
//     (e.g. an earlier in-flight close of the same ticket), the verdict
//     degrades to a JOURNALED ADVISORY and dispatch proceeds to the normal
//     gates. Blocking a close to "win" an authority dispute would widen risk.
//   * JOURNALED. Every arbitration — enforced or advisory — is recorded via
//     the caller's append-only audit writer. The service returns the journal
//     record; the pipeline must write it (test-pinned).
//   * FAIL-SAFE READS: a failed contention lookup returns a typed
//     CONTENTION_LOOKUP_FAILED with contention=UNKNOWN. For a risk-reducing
//     incoming command the pipeline proceeds (never trap a close on a read
//     failure); for a non-risk-reducing command the pipeline refuses
//     (default-deny toward action).

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, arxLiveCommandsTable } from "@workspace/db";
import {
  arbitrateManagementAuthority,
  claimSourceFromActorType,
  type ArbitrationDecision,
  type ManagementClaim,
} from "@workspace/domain/live-position";

/** Command types that manage an EXISTING position (contention is possible). */
const MANAGEMENT_COMMAND_TYPES = ["CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"] as const;

/** In-flight statuses whose claim on the position is still standing. */
const IN_FLIGHT_STATUSES = [
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
  "LIVE_UNKNOWN",
  "LIVE_RECONCILIATION_REQUIRED",
] as const;

export interface IncomingCommandFacts {
  commandId: string;
  userId: number;
  commandType: string;
  actorType: string | null;
  createdAt: Date | null;
  payload: unknown;
}

export type ManagementAuthorityVerdict =
  | { outcome: "NO_CONTENTION" }
  | { outcome: "PROCEED"; decision: ArbitrationDecision }
  | { outcome: "PROCEED_ADVISORY"; decision: ArbitrationDecision }
  | { outcome: "REFUSE"; decision: ArbitrationDecision }
  | { outcome: "LOOKUP_FAILED"; riskReducing: boolean };

export function brokerTicketOf(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const t = (payload as { brokerTicket?: unknown }).brokerTicket;
  return typeof t === "string" && t.trim() !== "" ? t : null;
}

function isRiskReducingType(commandType: string): boolean {
  // CLOSE is risk-reducing; MODIFY may loosen protection, so it is
  // conservatively NOT risk-reducing (unknown never resolves permissively).
  return commandType === "CLOSE_LIVE_POSITION";
}

function toClaim(row: {
  commandId: string;
  actorType: string | null;
  userId: number;
  commandType: string;
  createdAt: Date | null;
}): ManagementClaim {
  return {
    commandId: row.commandId,
    source: claimSourceFromActorType(row.actorType),
    actorUserId: row.userId,
    isRiskReducing: isRiskReducingType(row.commandType),
    claimedAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : "INVALID",
  };
}

/**
 * Evaluate management-authority contention for one incoming dispatch.
 * Never throws.
 */
export async function evaluateManagementAuthority(
  incoming: IncomingCommandFacts,
): Promise<ManagementAuthorityVerdict> {
  if (!(MANAGEMENT_COMMAND_TYPES as readonly string[]).includes(incoming.commandType)) {
    return { outcome: "NO_CONTENTION" };
  }
  const ticket = brokerTicketOf(incoming.payload);
  if (ticket == null) {
    // No position reference → nothing to contend over here; the pipeline's
    // own payload validation owns the missing-ticket failure mode.
    return { outcome: "NO_CONTENTION" };
  }

  const incomingRiskReducing = isRiskReducingType(incoming.commandType);

  let existingRows: {
    commandId: string;
    actorType: string | null;
    userId: number;
    commandType: string;
    createdAt: Date | null;
  }[];
  try {
    existingRows = await db
      .select({
        commandId: arxLiveCommandsTable.commandId,
        actorType: arxLiveCommandsTable.actorType,
        userId: arxLiveCommandsTable.userId,
        commandType: arxLiveCommandsTable.commandType,
        createdAt: arxLiveCommandsTable.createdAt,
      })
      .from(arxLiveCommandsTable)
      .where(and(
        ne(arxLiveCommandsTable.commandId, incoming.commandId),
        inArray(arxLiveCommandsTable.status, [...IN_FLIGHT_STATUSES]),
        inArray(arxLiveCommandsTable.commandType, [...MANAGEMENT_COMMAND_TYPES]),
        sql`${arxLiveCommandsTable.payload} ->> 'brokerTicket' = ${ticket}`,
      ));
  } catch {
    return { outcome: "LOOKUP_FAILED", riskReducing: incomingRiskReducing };
  }

  if (existingRows.length === 0) return { outcome: "NO_CONTENTION" };

  // Arbitrate against the EARLIEST standing claim (deterministic: createdAt
  // then commandId). If the incoming command beats the strongest-standing
  // claim it beats them all under the fixed precedence rules.
  const sorted = [...existingRows].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const tb = b.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.commandId < b.commandId ? -1 : 1;
  });
  const existing = sorted[0];

  const decision = arbitrateManagementAuthority(
    toClaim(existing),           // claim A — the standing claim
    toClaim({
      commandId: incoming.commandId,
      actorType: incoming.actorType,
      userId: incoming.userId,
      commandType: incoming.commandType,
      createdAt: incoming.createdAt,
    }),                          // claim B — the incoming claim
    incoming.userId,             // ownership already enforced by loadOwned()
  );

  if (decision.winner === "B") return { outcome: "PROCEED", decision };

  // Incoming lost (or nobody won). A risk-reducing incoming command is never
  // trapped: journal the adjudication and let the normal gates decide.
  if (incomingRiskReducing) return { outcome: "PROCEED_ADVISORY", decision };
  return { outcome: "REFUSE", decision };
}

export const MANAGEMENT_AUTHORITY_CONTENTION = "MANAGEMENT_AUTHORITY_CONTENTION" as const;
export const MANAGEMENT_AUTHORITY_LOOKUP_FAILED = "MANAGEMENT_AUTHORITY_LOOKUP_FAILED" as const;
