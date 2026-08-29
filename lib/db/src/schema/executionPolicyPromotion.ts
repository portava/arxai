// Capability #27 — execution-policy promotion state. ADDITIVE ONLY.
//
// SAFETY / SCOPE:
//   - STATE TABLE ONLY. No row here can place, modify, or close an order.
//     The chooser stays SHADOW regardless of this table's contents unless a
//     consumer explicitly reads an ENABLED row — and no dispatch-path
//     consumer exists yet (wiring one is a separate, reviewed change).
//   - AUTHORITY DIRECTION: automatic writers may only move status between
//     SHADOW and PRESS_UNLOCKED (both shadow-mode). ENABLED is written only
//     by the owner-press admin seam, with press-time evidence re-verified,
//     and every transition is journaled into historyJson with actor+reason.
//   - This table does NOT exist in any database until the raw SQL in
//     docs/migrations-pending/build-resilience.sql is applied (drizzle-kit
//     push is broken). Writers fail SAFE (mode resolves to SHADOW) and loud
//     when the table is absent.

import { pgTable, serial, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const executionPolicyPromotionsTable = pgTable("execution_policy_promotions", {
  id:             serial("id").primaryKey(),
  scope:          text("scope").notNull().default("platform"),
  // SHADOW | PRESS_UNLOCKED | ENABLED (domain PromotionStatus)
  status:         text("status").notNull().default("SHADOW"),
  statusEnteredAt: timestamp("status_entered_at", { withTimezone: true }).notNull(),
  // Latest PromotionEvidence snapshot (domain-shaped, replayable).
  evidenceJson:   jsonb("evidence_json"),
  // Append-only transition history: [{at, fromStatus, toStatus, kind: auto|owner_press|revert_press, actor, reasons}]
  historyJson:    jsonb("history_json"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeIdx: index("execution_policy_promotions_scope_idx").on(t.scope),
}));
export type ExecutionPolicyPromotionRow = typeof executionPolicyPromotionsTable.$inferSelect;
