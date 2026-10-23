// R2 slice S4 (schema half) — persisted reconciliation runs.
// (audit-execution.md G5; Master Blueprint §7 `reconciliation_runs`,
// spec lines 681–691, shape adapted to this codebase's integer FKs.)
//
// PURPOSE: a durable "when did we last compare ARX state against broker
// truth, and did it match" fact. Before this table, every reconciliation
// sweep was ephemeral by design (lib/reconciliation/detect.ts computes
// issues on the fly and persists nothing), so no "last reconciled at"
// existed for the risk path and no dispatch gate could consult
// reconciliation freshness. The urgent UNKNOWN-command reconciler
// (artifacts/api-server/src/lib/live/unknownReconciler.ts) writes one row
// per invocation; the wave-5 pipeline freshness pre-gate reads the latest
// row through the pure `reconciliationFreshnessVerdict` predicate exported
// there (this slice does NOT touch the pipeline).
//
// HONESTY CONTRACT:
//   - A run row records what the reconciler actually verified — never a
//     presumed-clean default. `positionsMatch` / `ordersMatch` are NULLABLE
//     three-state booleans: true = verified match, false = verified
//     mismatch, NULL = could not verify (evidence source unreadable).
//     The freshness predicate fails closed on NULL.
//   - `completedAt` NULL means the run never finished (crash evidence) —
//     also fails the freshness predicate. Rows are never deleted; the gate
//     reads only the newest row per scope.
//
// REGISTRATION (coordinator-owned): this table must be exported from
// lib/db/src/schema/index.ts before `drizzle-kit push` will create it on
// Replit — that barrel file is not edited from this slice. Until both the
// registration and the push land, the reconciler's raw-SQL writes to
// `reconciliation_runs` fail softly (try/caught, warn-only) and the
// freshness predicate keeps reporting NO_RUN — fail-closed, never
// fail-open. No data migration is needed; the table is purely additive.

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean, index,
} from "drizzle-orm/pg-core";

// scope: what the run covered. "user" = one user's unknown commands
// (reconcileUnknownCommands({userId})); "bridge" = a fleet sweep across
// bridges (no userId filter). Free-text column, additive discipline —
// future scopes (e.g. per-broker-account) extend without a migration.
export const RECONCILIATION_RUN_SCOPES = ["user", "bridge"] as const;
export type ReconciliationRunScope = (typeof RECONCILIATION_RUN_SCOPES)[number];

// status: RUNNING (inserted at start; a row stuck here is crash evidence),
// COMPLETED (finished — matches may still be false/NULL), FAILED (the run
// itself errored; matches are whatever was verified before the error).
export const RECONCILIATION_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const reconciliationRunsTable = pgTable("reconciliation_runs", {
  id: serial("id").primaryKey(),

  scope: text("scope").notNull(),
  // Integer FKs (loose, like the rest of the schema): mt5_connection.id and
  // users.id. Both nullable — a fleet-wide run has no single user, and a
  // user-scoped run may span multiple bridges (then bridgeConnectionId is
  // NULL and the per-bridge detail lives in mismatchSummary).
  bridgeConnectionId: integer("bridge_connection_id"),
  userId: integer("user_id"),

  status: text("status").notNull().default("RUNNING"),

  // Three-state verification verdicts — see HONESTY CONTRACT above.
  positionsMatch: boolean("positions_match"),
  ordersMatch: boolean("orders_match"),
  // Full machine-readable outcome: counts, per-command verdicts, held
  // commands with hold reasons, errors. Never trimmed to a counter.
  mismatchSummary: jsonb("mismatch_summary").notNull().default({}),

  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  // Freshness reads: newest completed run for a user / a bridge.
  userStartedIdx: index("reconciliation_runs_user_started_idx").on(t.userId, t.startedAt),
  bridgeStartedIdx: index("reconciliation_runs_bridge_started_idx").on(t.bridgeConnectionId, t.startedAt),
  completedIdx: index("reconciliation_runs_completed_idx").on(t.completedAt),
}));

export type ReconciliationRun = typeof reconciliationRunsTable.$inferSelect;
export type NewReconciliationRun = typeof reconciliationRunsTable.$inferInsert;
