// Master Live — Per-User Access Gate
//
// Runs BEFORE the master-bridge gate (which itself runs before Phase B)
// whenever `accountRoutingMode = SHARED_MASTER_MT5`. Refuses dispatch
// when the per-user access row says the user is not approved, the
// per-user toggle is off, the user is suspended, or the user is risk-
// locked. Block reasons match the spec exactly:
//
//   USER_NOT_APPROVED_FOR_MASTER_LIVE     (no row OR status NOT_APPROVED)
//   USER_MASTER_LIVE_TOGGLE_OFF           (master_live_trading_enabled=false
//                                           OR status DISABLED)
//   USER_MASTER_LIVE_SUSPENDED            (status SUSPENDED)
//   USER_MASTER_LIVE_RISK_LOCKED          (status RISK_LOCKED)
//   USER_MISSING_RISK_DISCLOSURE          (risk_disclosure_accepted_at null)
//   USER_MISSING_RISK_SETTINGS            (risk_settings_configured_at null)
//
// SECURITY: pure evaluator + tiny DB loader. Never imports any
// trade-placing function. Returns DECISION only — caller (pipeline)
// writes LIVE_BLOCKED audit row and refuses dispatch.
import { eq } from "drizzle-orm";
import { db, userMasterLiveAccessTable, type UserMasterLiveAccess, type MasterLiveStatus } from "@workspace/db";

export type UserMasterLiveAccessBlockReason =
  | "USER_NOT_APPROVED_FOR_MASTER_LIVE"
  | "USER_LIVE_BRIDGE_REQUEST_PENDING"
  | "USER_LIVE_BRIDGE_REQUEST_DENIED"
  | "USER_MASTER_LIVE_REVOKED"
  | "USER_MASTER_LIVE_TOGGLE_OFF"
  | "USER_MASTER_LIVE_SUSPENDED"
  | "USER_MASTER_LIVE_RISK_LOCKED"
  | "USER_MISSING_RISK_DISCLOSURE"
  | "USER_MISSING_RISK_SETTINGS";

export interface UserMasterLiveAccessGateInput {
  // Null when no row exists for this user (i.e. new user).
  access: UserMasterLiveAccess | null;
}

export type UserMasterLiveAccessGateResult =
  | { decision: "PASS"; access: UserMasterLiveAccess }
  | {
      decision: "BLOCKED";
      primaryReason: UserMasterLiveAccessBlockReason;
      blockReasons: UserMasterLiveAccessBlockReason[];
      status: MasterLiveStatus | "NO_ROW";
    };

/** Pure evaluator — no I/O. Order of checks is the order in the spec. */
export function evaluateUserMasterLiveAccessGate(
  input: UserMasterLiveAccessGateInput,
): UserMasterLiveAccessGateResult {
  const a = input.access;
  // No row at all → treat as the strictest possible state.
  if (!a) {
    return {
      decision: "BLOCKED",
      primaryReason: "USER_NOT_APPROVED_FOR_MASTER_LIVE",
      blockReasons: ["USER_NOT_APPROVED_FOR_MASTER_LIVE"],
      status: "NO_ROW",
    };
  }
  const status = a.masterLiveStatus as MasterLiveStatus;
  const reasons: UserMasterLiveAccessBlockReason[] = [];

  // Status precedence — risk-lock and suspension trump approval. The
  // Phase 22V Part 2 statuses (PENDING_REQUEST, DENIED, REVOKED) are
  // all forms of "not approved" with friendlier reasons.
  if (status === "RISK_LOCKED") reasons.push("USER_MASTER_LIVE_RISK_LOCKED");
  if (status === "SUSPENDED") reasons.push("USER_MASTER_LIVE_SUSPENDED");
  if (status === "REVOKED") reasons.push("USER_MASTER_LIVE_REVOKED");
  if (status === "DENIED") reasons.push("USER_LIVE_BRIDGE_REQUEST_DENIED");
  if (status === "PENDING_REQUEST") reasons.push("USER_LIVE_BRIDGE_REQUEST_PENDING");
  if (status === "NOT_APPROVED") reasons.push("USER_NOT_APPROVED_FOR_MASTER_LIVE");
  if (!a.approvedForMasterLive && status !== "RISK_LOCKED" && status !== "SUSPENDED" && status !== "REVOKED" && status !== "DENIED" && status !== "PENDING_REQUEST") {
    // Defence-in-depth: even if status drifted, the boolean must be true.
    if (!reasons.includes("USER_NOT_APPROVED_FOR_MASTER_LIVE")) {
      reasons.push("USER_NOT_APPROVED_FOR_MASTER_LIVE");
    }
  }
  if (status === "DISABLED" || !a.masterLiveTradingEnabled) {
    if (reasons.length === 0) reasons.push("USER_MASTER_LIVE_TOGGLE_OFF");
    else if (!reasons.includes("USER_MASTER_LIVE_TOGGLE_OFF")) reasons.push("USER_MASTER_LIVE_TOGGLE_OFF");
  }
  // Disclosure requirement is satisfied when EITHER the user accepted it OR
  // an OWNER/ADMIN waived it (honest operator override, recorded on the row as
  // disclosure_waived_at / _by / _reason — never as user acceptance).
  if (!a.riskDisclosureAcceptedAt && !a.disclosureWaivedAt) reasons.push("USER_MISSING_RISK_DISCLOSURE");
  if (!a.riskSettingsConfiguredAt) reasons.push("USER_MISSING_RISK_SETTINGS");

  if (reasons.length > 0) {
    return {
      decision: "BLOCKED",
      primaryReason: reasons[0]!,
      blockReasons: reasons,
      status,
    };
  }
  return { decision: "PASS", access: a };
}

/**
 * DB loader — reads the per-user access row (or null) and evaluates.
 * Used by `dispatchLiveCommand`, the route layer (so UI can render
 * "what's blocking you"), and the QA script. Never imports any trade-
 * placing function.
 */
export async function loadAndEvaluateUserMasterLiveAccessGate(
  userId: number,
): Promise<UserMasterLiveAccessGateResult> {
  const rows = await db.select().from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  return evaluateUserMasterLiveAccessGate({ access: rows[0] ?? null });
}
