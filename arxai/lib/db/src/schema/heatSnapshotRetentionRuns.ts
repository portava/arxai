// Heat Snapshot Retention Runs — audit/status log for the automatic
// heat_snapshots pruning policy (Task #266).
//
// Append-only record of every retention run (automatic or admin-triggered,
// real or dry-run). Powers the admin "retention status" surface (last run,
// rows pruned, protected rows, oldest retained) and serves as the safe
// logging/audit trail for pruning. Never an execution gate; never deletes
// audit-critical records itself — it only records what a prune run did.

import { pgTable, serial, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const heatSnapshotRetentionRunsTable = pgTable(
  "heat_snapshot_retention_runs",
  {
    id: serial("id").primaryKey(),
    ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
    // "AUTOMATIC" (scheduled worker) | "ADMIN" (manual admin trigger)
    trigger: text("trigger").notNull(),
    dryRun: boolean("dry_run").notNull(),
    // Rows older than the cutoff that were considered for deletion.
    rowsScanned: integer("rows_scanned").notNull(),
    // Rows actually deleted (0 on dry-run).
    rowsDeleted: integer("rows_deleted").notNull(),
    // Eligible-by-age rows that were spared because they are decision-linked.
    protectedRows: integer("protected_rows").notNull(),
    // The age cutoff used for this run (rows older than this were eligible).
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    // Oldest snapshot that remains after the run (null if table empty).
    oldestRetainedAt: timestamp("oldest_retained_at", { withTimezone: true }),
    actorUserId: integer("actor_user_id"),
    reason: text("reason"),
    // Frozen copy of the policy that produced this run (for forensics).
    policySnapshot: jsonb("policy_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("heat_snapshot_retention_runs_ran_at_idx").on(t.ranAt),
  ],
);
