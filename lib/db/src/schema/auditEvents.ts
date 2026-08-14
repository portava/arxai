import { pgTable, serial, text, jsonb, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Event-Sourced Black Box Vault — parallel SHADOW audit log ─────────────
// Append-only mirror of every important system event. Distinct from
// vault_events (Phase 1/2 truth-store log): audit_events is event-sourced
// with cryptographic chaining (previousEventId + checksum) so tampering or
// gaps can be detected even if the primary log is later compromised.

export const auditEventsTable = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  timestamp: text("timestamp").notNull(),
  eventType: text("event_type").notNull(),
  source: text("source").notNull(),
  severity: text("severity").notNull(),
  systemMode: text("system_mode"),
  globalState: text("global_state"),
  payload: jsonb("payload").notNull().default({}),
  previousEventId: text("previous_event_id"),
  checksum: text("checksum").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  trainingEligible: boolean("training_eligible").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  byEventType: index("audit_events_type_idx").on(t.eventType),
  bySeverity:  index("audit_events_sev_idx").on(t.severity),
  bySource:    index("audit_events_source_idx").on(t.source),
  byTimestamp: index("audit_events_ts_idx").on(t.timestamp),
  byPrev:      index("audit_events_prev_idx").on(t.previousEventId),
  byCreatedAt: index("audit_events_created_idx").on(t.createdAt),
}));

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit({ id: true });
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEventRow = typeof auditEventsTable.$inferSelect;
