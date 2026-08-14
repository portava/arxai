// Operator-Funded Pilot — pure gate evaluated BEFORE Phase B's 16 gates.
//
// SAFETY: this gate never PASSes on its own. It only ADDS to existing
// blockers. A PASS here means the pilot-specific conditions are met —
// the existing Phase B 16-gate evaluator and user-master-live-access
// gate still run after and can independently BLOCK.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  betaInvitesTable,
  liveRiskDisclosureAcceptancesTable,
  userMasterLiveAccessTable,
  virtualTradingAccountsTable,
  globalTradingSettingsTable,
} from "@workspace/db";
import {
  OPERATOR_FUNDED_PILOT_COHORT,
  OPERATOR_FUNDED_PILOT_MAX_USERS,
  OPERATOR_FUNDED_DISCLOSURE_VERSION,
  PILOT_BLOCK_REASONS,
  operatorFundedPilotEnabled,
  type PilotBlockReason,
} from "./operatorFundedPilotConfig.js";

// Re-export so existing call sites that import from the gate keep working
// after operatorFundedPilotGate dropped local use of MAX_USERS.
export { OPERATOR_FUNDED_PILOT_MAX_USERS };

export interface PilotGateResult {
  decision: "PASS" | "BLOCKED";
  primaryReason: PilotBlockReason | null;
  blockReasons: PilotBlockReason[];
  evaluatedAt: string;
}

/**
 * Evaluates the operator-funded pilot pre-conditions for a given user.
 * Returns PASS only when EVERY pilot condition is met. Otherwise returns
 * BLOCKED with the exact failing pilot rule(s). Never widens access.
 */
export async function evaluateOperatorFundedPilotGate(args: {
  userId: number;
}): Promise<PilotGateResult> {
  const blockReasons: PilotBlockReason[] = [];

  // 1. Server master switch
  if (!operatorFundedPilotEnabled()) {
    blockReasons.push(PILOT_BLOCK_REASONS.PILOT_DISABLED);
  }

  // 2. User is in the beta cohort AND has accepted the invite
  const inviteRows = await db
    .select({
      id: betaInvitesTable.id,
      acceptedAt: betaInvitesTable.acceptedAt,
    })
    .from(betaInvitesTable)
    .where(
      and(
        eq(betaInvitesTable.cohort, OPERATOR_FUNDED_PILOT_COHORT),
        eq(betaInvitesTable.acceptedUserId, args.userId),
      ),
    )
    .limit(1);
  const invite = inviteRows[0] ?? null;
  if (!invite) {
    blockReasons.push(PILOT_BLOCK_REASONS.NOT_BETA);
  } else if (!invite.acceptedAt) {
    blockReasons.push(PILOT_BLOCK_REASONS.BETA_NOT_ACCEPTED);
  }

  // 3. Compliance/legal review approved on the global singleton
  const gtsRows = await db.select().from(globalTradingSettingsTable).limit(1);
  const gts = gtsRows[0] ?? null;
  if (!gts || gts.complianceReviewFlag !== true) {
    blockReasons.push(PILOT_BLOCK_REASONS.COMPLIANCE_NOT_APPROVED);
  }

  // 4. Operator-assigned allocation > 0
  const vtaRows = await db
    .select({ virtualBalance: virtualTradingAccountsTable.virtualBalance })
    .from(virtualTradingAccountsTable)
    .where(eq(virtualTradingAccountsTable.userId, args.userId))
    .limit(1);
  const allocation = Number(vtaRows[0]?.virtualBalance ?? 0);
  if (!(allocation > 0)) {
    blockReasons.push(PILOT_BLOCK_REASONS.NO_ALLOCATION);
  }

  // 4b. Defense-in-depth cohort cap: even if admission ever overshot due
  //     to a race, only the first MAX_USERS approved users (ordered by
  //     approval time, then id as a stable tiebreaker) can dispatch live.
  //     Any "overshoot" user is blocked here with COHORT_CAP_EXCEEDED.
  //     This makes the dispatch path fail-closed independent of the admin
  //     route's transactional correctness.
  const capRows = await db.execute<{ within_cap: number }>(sql`
    WITH ranked AS (
      SELECT user_id,
             ROW_NUMBER() OVER (
               ORDER BY COALESCE(master_live_approved_at, NOW()) ASC, id ASC
             ) AS rn
        FROM user_master_live_access
       WHERE master_live_status = 'APPROVED'
         AND approved_for_master_live = TRUE
    )
    SELECT 1 AS within_cap FROM ranked
     WHERE user_id = ${args.userId}
       AND rn <= ${OPERATOR_FUNDED_PILOT_MAX_USERS}
     LIMIT 1
  `);
  const capRowsList = (capRows as unknown as { rows?: Array<{ within_cap: number }> }).rows
    ?? (capRows as unknown as Array<{ within_cap: number }>);
  // Only enforce overshoot block when user is actually APPROVED. Non-approved
  // users are already blocked elsewhere; adding this reason there would be
  // noisy and confusing.
  const isApproved = await db
    .select({ id: userMasterLiveAccessTable.id })
    .from(userMasterLiveAccessTable)
    .where(
      and(
        eq(userMasterLiveAccessTable.userId, args.userId),
        eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
        eq(userMasterLiveAccessTable.approvedForMasterLive, true),
      ),
    )
    .limit(1);
  if (isApproved.length > 0 && (!capRowsList || capRowsList.length === 0)) {
    blockReasons.push(PILOT_BLOCK_REASONS.COHORT_CAP_EXCEEDED);
  }

  // 5. Operator-funded disclosure accepted by VERSION (not generic)
  const discRows = await db
    .select({ id: liveRiskDisclosureAcceptancesTable.id })
    .from(liveRiskDisclosureAcceptancesTable)
    .where(
      and(
        eq(liveRiskDisclosureAcceptancesTable.userId, args.userId),
        eq(
          liveRiskDisclosureAcceptancesTable.disclosureVersion,
          OPERATOR_FUNDED_DISCLOSURE_VERSION,
        ),
      ),
    )
    .limit(1);
  if (discRows.length === 0) {
    blockReasons.push(PILOT_BLOCK_REASONS.DISCLOSURE_MISSING);
  }

  return {
    decision: blockReasons.length === 0 ? "PASS" : "BLOCKED",
    primaryReason: blockReasons[0] ?? null,
    blockReasons,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Returns the current count of users who currently hold APPROVED
 * master-live access. Used by the admin approval route to refuse the
 * 11th approval. Never counts SUSPENDED / DISABLED / RISK_LOCKED rows.
 */
export async function countApprovedPilotUsers(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(userMasterLiveAccessTable)
    .where(
      and(
        eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
        eq(userMasterLiveAccessTable.approvedForMasterLive, true),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Returns true iff `userId` is currently in the APPROVED master-live
 * cohort (so an already-approved user can be re-approved/updated
 * without tripping the cap).
 */
export async function isUserAlreadyApproved(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: userMasterLiveAccessTable.id })
    .from(userMasterLiveAccessTable)
    .where(
      and(
        eq(userMasterLiveAccessTable.userId, userId),
        eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Returns true iff `userId` has an accepted ARX_PRIVATE_BETA_10 invite.
 * Used at admin-approve time to refuse approving a non-beta user.
 */
export async function isUserAcceptedBeta(userId: number): Promise<boolean> {
  const rows = await db
    .select({ acceptedAt: betaInvitesTable.acceptedAt })
    .from(betaInvitesTable)
    .where(
      and(
        eq(betaInvitesTable.cohort, OPERATOR_FUNDED_PILOT_COHORT),
        eq(betaInvitesTable.acceptedUserId, userId),
        isNotNull(betaInvitesTable.acceptedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
