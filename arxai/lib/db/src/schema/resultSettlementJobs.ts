// Durable server-only settlement intents. Never broker dispatch work.
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
export const resultSettlementJobsTable = pgTable(
  "result_settlement_jobs",
  {
    id: serial("id").primaryKey(),
    commandRowId: integer("command_row_id").notNull(),
    userId: integer("user_id").notNull(),
    consumer: text("consumer").notNull(),
    receiptFingerprint: text("receipt_fingerprint").notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    reason: text("reason"),
    completedGeneration: integer("completed_generation"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    commandConsumer: uniqueIndex("result_settlement_command_consumer_uq").on(
      t.commandRowId,
      t.consumer,
    ),
    ready: index("result_settlement_ready_idx").on(t.status, t.dueAt, t.id),
  }),
);
