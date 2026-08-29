// Master Live Trading — Per-User Access Gate
//
// Even when the platform master bridge is connected and master live is
// enabled, individual users are NOT allowed to trade until an admin has
// explicitly approved them AND flipped their per-user toggle on.
//
// Two tables:
//
//   user_master_live_access  — one row per user, current access state
//   master_live_access_audit — append-only audit log of every admin action
//
// Status values map 1:1 to the gate block reasons:
//   NOT_APPROVED      -> USER_NOT_APPROVED_FOR_MASTER_LIVE
//   PENDING_REQUEST   -> USER_LIVE_BRIDGE_REQUEST_PENDING (Phase 22V Part 2)
//   APPROVED          -> ok (still requires master_live_trading_enabled=true)
//   DENIED            -> USER_LIVE_BRIDGE_REQUEST_DENIED (Phase 22V Part 2)
//   SUSPENDED         -> USER_MASTER_LIVE_SUSPENDED
//   DISABLED          -> USER_MASTER_LIVE_TOGGLE_OFF
//   REVOKED           -> USER_MASTER_LIVE_REVOKED (Phase 22V Part 2)
//   RISK_LOCKED       -> USER_MASTER_LIVE_RISK_LOCKED
//
// SECURITY: every mutation must be performed only by ADMIN/OWNER routes
// that also write a `master_live_access_audit` row in the same request.
import {
  pgTable, serial, integer, boolean, text, timestamp, doublePrecision, jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userMasterLiveAccessTable = pgTable(
  "user_master_live_access",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),

    // Admin-controlled approval (the "operator selected this user" flag).
    approvedForMasterLive: boolean("approved_for_master_live").notNull().default(false),
    // Admin-controlled per-user toggle (separate from approval so an
    // operator can pause a user without revoking their approval record).
    masterLiveTradingEnabled: boolean("master_live_trading_enabled").notNull().default(false),

    // Provenance for last approval / disable / suspend / risk-lock.
    masterLiveApprovedBy: integer("master_live_approved_by"),
    masterLiveApprovedAt: timestamp("master_live_approved_at"),
    masterLiveDisabledBy: integer("master_live_disabled_by"),
    masterLiveDisabledAt: timestamp("master_live_disabled_at"),

    // High-level status (drives UI badge + gate block reason).
    masterLiveStatus: text("master_live_status").notNull().default("NOT_APPROVED"),
    // Required user acks before any trade can go through (see #3 in spec).
    riskDisclosureAcceptedAt: timestamp("risk_disclosure_accepted_at"),
    riskSettingsConfiguredAt: timestamp("risk_settings_configured_at"),

    // Operator disclosure waiver — an OWNER/ADMIN may waive the
    // live-trading risk-disclosure requirement for a specific user. This is
    // recorded HONESTLY as an operator override (who waived it + when + why),
    // NEVER as the user having accepted the disclosure (that remains
    // `riskDisclosureAcceptedAt`, set only by the user's own action). Both the
    // per-user access gate and the Phase B #18 disclosure gate treat the
    // requirement as satisfied when EITHER the user accepted OR an operator
    // waiver is present. Default-deny: null = no waiver.
    disclosureWaivedAt: timestamp("disclosure_waived_at"),
    disclosureWaivedBy: integer("disclosure_waived_by"),
    disclosureWaiverReason: text("disclosure_waiver_reason"),

    // Per-user trading caps surfaced on the admin "Master Live User Access"
    // table. Server treats them as soft caps — the master-live access gate
    // refuses dispatch when current exposure / daily P/L breaches the cap.
    allowedSymbols: jsonb("allowed_symbols").$type<string[]>().default([]),
    maxLot: doublePrecision("max_lot"),
    dailyLossLimitUsd: doublePrecision("daily_loss_limit_usd"),
    // Concurrency cap — max open live positions across all symbols.
    // null = unset (no per-user cap; falls back to system default if any).
    // The dispatch pipeline refuses entry orders when current open count
    // would exceed this value, emitting MAX_OPEN_POSITIONS_REACHED.
    maxOpenPositions: integer("max_open_positions"),
    // Per-symbol exposure cap in lots. The dispatch pipeline refuses entry
    // orders when the post-trade exposure on the command's symbol would
    // exceed this value, emitting MAX_EXPOSURE_PER_SYMBOL_REACHED.
    maxExposurePerSymbolLots: doublePrecision("max_exposure_per_symbol_lots"),
    // Foundation gate #21 — capital tier ("T0" | "T1" | "T2" | "T3", see
    // lib/domain safety-contracts/foundationGates.ts CAPITAL_TIERS). Nullable
    // + additive: NULL = unassigned = the MOST RESTRICTIVE tier (T0,
    // default-deny), an unrecognised literal REFUSES dispatch (fail closed,
    // never guess a cap). The tier can only TIGHTEN the caps above (effective
    // cap = min(tier cap, maxLot)) — never loosen them. Migration: additive
    // nullable column, no backfill (drizzle push on Replit later).
    capitalTier: text("capital_tier"),
    requireStopLoss: boolean("require_stop_loss").notNull().default(true),
    // Phase 22V Part 2 — require TP at dispatch for approved-shared-bridge users.
    requireTakeProfit: boolean("require_take_profit").notNull().default(true),
    scannerLiveEnabled: boolean("scanner_live_enabled").notNull().default(false),

    // Phase 22V Part 2 — user-initiated request flow.
    liveBridgeRequestedAt: timestamp("live_bridge_requested_at"),
    liveBridgeRequestNote: text("live_bridge_request_note"),
    liveBridgeRequestRiskDisclosureAcceptedAt: timestamp("live_bridge_request_risk_disclosure_accepted_at"),
    liveBridgeDeniedBy: integer("live_bridge_denied_by"),
    liveBridgeDeniedAt: timestamp("live_bridge_denied_at"),
    liveBridgeDeniedReason: text("live_bridge_denied_reason"),
    liveBridgeRevokedBy: integer("live_bridge_revoked_by"),
    liveBridgeRevokedAt: timestamp("live_bridge_revoked_at"),
    liveBridgeRevokedReason: text("live_bridge_revoked_reason"),
    // Default route the approved user lands in. Always SHARED_MASTER_MT5
    // for approved-shared-bridge users; informational only — backend still
    // enforces the actual routing via global_trading_settings.
    defaultExecutionRoute: text("default_execution_route").notNull().default("SHARED_MASTER_MT5"),

    // Phase 22V Part 3 — risk template assignment.
    // FK is intentionally NOT enforced at the DB layer (no .references())
    // so this column can be populated before the template row exists in
    // tests/dev. The approve handler's find-or-create flow always inserts
    // the template row first, then sets this column. Nullable so users
    // not yet approved have no assigned template.
    assignedRiskTemplateId: integer("assigned_risk_template_id"),

    // Task #353 — Bridge-type-aware armed one-click permission.
    // For shared-bridge users only: admin must grant permission before the
    // user can arm one-click trading. Own-bridge users self-arm directly.
    // Revoking auto-disarms the user's one_click_armed flag.
    sharedBridgeOneClickPermitted: boolean("shared_bridge_one_click_permitted").notNull().default(false),
    sharedBridgeOneClickPermittedBy: integer("shared_bridge_one_click_permitted_by"),
    sharedBridgeOneClickPermittedAt: timestamp("shared_bridge_one_click_permitted_at"),
    sharedBridgeOneClickRevokedBy: integer("shared_bridge_one_click_revoked_by"),
    sharedBridgeOneClickRevokedAt: timestamp("shared_bridge_one_click_revoked_at"),

    // Task #737 — Approved-trader live activation.
    //
    // SAFETY: these fields drive the NEW `LIVE_EXECUTION_ACTIVATION_GATE` only.
    // That gate ADDS a precondition to the live order path — it never weakens,
    // skips, or ORs around any of the 18 Phase B dispatch gates, the kill
    // switch, per-user allocation, the risk governor, symbol approval, or
    // account status. Real-money execution remains default-deny.
    //
    // `liveExecutionEnabled` is the gate's positive precondition. The gate
    // passes ONLY when liveExecutionEnabled === true AND
    // liveConfirmationRequired === false. Both must be honestly set through the
    // approval/arming path — never as a standalone flag without the supporting
    // shared-live rows + arx_live_arming.is_armed.
    liveExecutionEnabled: boolean("live_execution_enabled").notNull().default(false),
    // How execution was activated (honest provenance):
    //   user_confirmation     — the trader completed the personal arming phrase.
    //   admin_full_activation — an admin used Full Live Activation (typed phrase
    //                           + acknowledgement) to stand in for the personal
    //                           confirmation step (audited bypass of the PHRASE
    //                           ONLY — every order-time gate still runs).
    //   admin_disabled        — an admin turned live execution off.
    //   system_revoked        — the system revoked execution (safety).
    liveExecutionActivationSource: text("live_execution_activation_source"),
    liveExecutionActivatedBy: integer("live_execution_activated_by"),
    liveExecutionActivatedAt: timestamp("live_execution_activated_at"),
    // True until the trader's personal live-confirmation step is satisfied —
    // either by the trader themselves (sets liveConfirmationCompletedAt) or by
    // an audited admin Full Live Activation (sets liveConfirmationBypassedByAdmin
    // to the admin's user id). Default-deny: starts true.
    liveConfirmationRequired: boolean("live_confirmation_required").notNull().default(true),
    liveConfirmationCompletedAt: timestamp("live_confirmation_completed_at"),
    liveConfirmationBypassedByAdmin: integer("live_confirmation_bypassed_by_admin"),
    // Which shared live bridge the approval attached this trader to. The actual
    // routing truth still lives in virtual_trading_accounts + the slot
    // allocation + global_trading_settings; this is a traceability pointer for
    // the resolver and admin diagnostics, never a standalone routing source.
    assignedLiveBridgeId: integer("assigned_live_bridge_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userUq: uniqueIndex("user_master_live_access_user_id_uq").on(t.userId),
  }),
);

export type UserMasterLiveAccess = typeof userMasterLiveAccessTable.$inferSelect;
export type MasterLiveStatus =
  | "NOT_APPROVED"
  | "PENDING_REQUEST"
  | "APPROVED"
  | "DENIED"
  | "SUSPENDED"
  | "DISABLED"
  | "REVOKED"
  | "RISK_LOCKED";

export const MASTER_LIVE_ACCESS_ACTIONS = [
  "REQUEST_SUBMITTED",
  "APPROVED",
  "DENIED",
  "ENABLED",
  "DISABLED",
  "REVOKED",
  "SUSPENDED",
  "RISK_LOCKED",
  "RESET",
  "TOGGLE_ON",
  "TOGGLE_OFF",
  "LIMITS_UPDATED",
  "APPROVED_DEFAULTS_APPLIED",
  // Phase 22V Part 3 — risk template assignment + LIVE default mode.
  "RISK_TEMPLATE_ASSIGNED",
  "DEFAULT_LIVE_MODE_SET",
  // Task #353 — Bridge-type-aware armed one-click permission (shared-bridge).
  "ONE_CLICK_PERMISSION_GRANTED",
  "ONE_CLICK_PERMISSION_REVOKED",
  // Operator disclosure waiver — honest owner/admin override of the
  // live-trading risk-disclosure requirement (recorded as an operator
  // action, never as the user accepting).
  "DISCLOSURE_WAIVED",
  "DISCLOSURE_WAIVER_REVOKED",
  // Task #737 — Approved-trader live activation audit actions.
  "LIVE_BRIDGE_APPROVED",
  "FULL_LIVE_ACTIVATION_ENABLED",
  "LIVE_EXECUTION_DISABLED",
  "LIVE_CONFIRMATION_REQUIRED_AGAIN",
  "BULK_FULL_LIVE_ACTIVATION_ENABLED",
  "BULK_LIVE_BRIDGE_REPAIR",
] as const;
export type MasterLiveAccessAction = (typeof MASTER_LIVE_ACCESS_ACTIONS)[number];

export const masterLiveAccessAuditTable = pgTable("master_live_access_audit", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id").notNull().references(() => usersTable.id),
  targetUserId: integer("target_user_id").notNull().references(() => usersTable.id),
  action: text("action").notNull(),
  reason: text("reason"),
  // Snapshot of {before, after} for the access row + the admin source IP
  // (set by the route layer). Never includes any token or password hash.
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type MasterLiveAccessAudit = typeof masterLiveAccessAuditTable.$inferSelect;
