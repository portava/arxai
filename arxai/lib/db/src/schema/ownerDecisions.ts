import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Owner Decision Registry (Blueprint Part II #54, Phase 0) ───────────────
// APPEND-ONLY ledger of business, risk, regulatory and product rulings with
// rationale. Forward-fix only: a ruling is never edited or deleted — a new row
// that names its predecessor via supersedesId replaces it. There are NO
// UPDATE/DELETE paths (schema, routes, or services) and none may be added.
// Agents may surface decisions but not silently replace them.

export const ownerDecisionsTable = pgTable("owner_decisions", {
  id: serial("id").primaryKey(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  decidedBy: text("decided_by").notNull(),
  title: text("title").notNull(),
  decision: text("decision").notNull(),
  context: text("context"),
  // Forward-fix pointer: the earlier ruling this one replaces, if any.
  supersedesId: integer("supersedes_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDecidedAt: index("owner_decisions_decided_at_idx").on(t.decidedAt),
  bySupersedes: index("owner_decisions_supersedes_idx").on(t.supersedesId),
}));

export const insertOwnerDecisionSchema = createInsertSchema(ownerDecisionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertOwnerDecision = z.infer<typeof insertOwnerDecisionSchema>;
export type OwnerDecisionRow = typeof ownerDecisionsTable.$inferSelect;
