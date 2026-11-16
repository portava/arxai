// Phase 22V — Per-user risk profile resolver.
//
// PROFILES (named by `risk_templates.name`):
//   - "Approved Shared Bridge Default"  → default safe caps
//   - "First Live Test Mode"            → tightest possible (FLTM preset)
//   - "Owner Unrestricted Live"         → OWNER-only; removes the four
//       app-level caps (symbol/lot/daily-loss/SL+TP) so the 16-gate
//       evaluator is driven purely by the safety facts (master switch,
//       arming, kill switch, bridge heartbeat, EA flags, account type,
//       manual confirmation, audit). Auto-assigned to OWNER role (or
//       bootstrapped user_id=4) when no explicit template is set;
//       assignable to other users only by an ADMIN via the explicit
//       admin opt-in path.
//
// IMPORTANT: This module does NOT change the 16-gate evaluator itself.
// It returns a small `overrides` shape that the pipeline applies to the
// gate input AND to the preflight checks. Every other gate remains in
// force. arx_live_commands rows still require a manual confirmation
// transition before dispatch. Audit rows are still written.

import { eq } from "drizzle-orm";
import { db, userMasterLiveAccessTable, riskTemplatesTable, usersTable } from "@workspace/db";

export const RISK_PROFILE_NAMES = {
  APPROVED_SHARED_BRIDGE_DEFAULT: "Approved Shared Bridge Default",
  FIRST_LIVE_TEST_MODE: "First Live Test Mode",
  OWNER_UNRESTRICTED_LIVE: "Owner Unrestricted Live",
} as const;

export type RiskProfileName =
  | typeof RISK_PROFILE_NAMES.APPROVED_SHARED_BRIDGE_DEFAULT
  | typeof RISK_PROFILE_NAMES.FIRST_LIVE_TEST_MODE
  | typeof RISK_PROFILE_NAMES.OWNER_UNRESTRICTED_LIVE;

export interface UserRiskProfileSummary {
  templateId: number | null;
  templateName: string | null;
  isOwnerUnrestricted: boolean;
}

/**
 * Resolves the risk-profile assignment for a user by joining
 * user_master_live_access.assigned_risk_template_id → risk_templates.name.
 * `isOwnerUnrestricted` is true ONLY when the assigned template is
 * "Owner Unrestricted Live". This flag never short-circuits the 16-gate
 * evaluator — it only relaxes the four input fields the pipeline derives
 * from per-user settings (symbol allowlist, per-symbol lot cap, daily-loss
 * cap, SL/TP requirements) plus the per-user exposure gates
 * (maxOpenPositions, maxExposurePerSymbolLots).
 */
export async function getUserRiskProfile(userId: number): Promise<UserRiskProfileSummary> {
  const rows = await db.select({
    templateId: userMasterLiveAccessTable.assignedRiskTemplateId,
  }).from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  const templateId = rows[0]?.templateId ?? null;

  if (templateId != null) {
    // Explicit admin assignment — honor the assigned template.
    const tplRows = await db.select({
      name: riskTemplatesTable.name,
    }).from(riskTemplatesTable)
      .where(eq(riskTemplatesTable.id, templateId)).limit(1);
    const name = tplRows[0]?.name ?? null;
    return {
      templateId,
      templateName: name,
      isOwnerUnrestricted: name === RISK_PROFILE_NAMES.OWNER_UNRESTRICTED_LIVE,
    };
  }

  // T008 — No explicit template assignment. Auto-resolve the bootstrapped
  // OWNER (role=OWNER OR user_id=4) to `isOwnerUnrestricted=true` so the
  // operator's own account is not bound by demo/default starter caps on
  // their personal manual trade tickets. Non-OWNER users without an
  // explicit assignment stay restricted (their assigned caps apply, or
  // missing caps block them — `isOwnerUnrestricted=false` is the safe
  // default). This change ONLY affects the four input fields the
  // pipeline derives from per-user settings (symbol allowlist,
  // per-symbol lot cap, daily-loss cap, SL/TP requirements). It does
  // NOT bypass: the 16-gate evaluator, master switch, kill switch,
  // bridge heartbeat, EA flags, account type, manual confirmation, or
  // audit logging — those are all re-checked at dispatch time.
  if (await isOwnerRole(userId)) {
    return {
      templateId: null,
      templateName: `${RISK_PROFILE_NAMES.OWNER_UNRESTRICTED_LIVE} (auto for OWNER)`,
      isOwnerUnrestricted: true,
    };
  }

  return { templateId: null, templateName: null, isOwnerUnrestricted: false };
}

/**
 * Checks that `targetUserId` has role=OWNER. Used to refuse assigning
 * the unrestricted profile to non-OWNER users. ADMINs are NOT eligible
 * — only the bootstrapped OWNER (user_id=4 OR role=OWNER).
 */
export async function isOwnerRole(targetUserId: number): Promise<boolean> {
  const rows = await db.select({
    id: usersTable.id, role: usersTable.role,
  }).from(usersTable)
    .where(eq(usersTable.id, targetUserId)).limit(1);
  if (!rows[0]) return false;
  return rows[0].role === "OWNER" || rows[0].id === 4;
}
