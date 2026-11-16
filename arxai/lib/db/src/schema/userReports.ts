// Phase 11A — Per-user report exports. Additive table; never collides with
// legacy export/report tables. Reports are user-owned and scoped by userId.
// SAFETY: bodies must never contain raw bridge tokens, apiKeyHash, secrets,
// or other users' data. The reportBuilder service is responsible for that.
import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const userReportsTable = pgTable("user_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  reportType: text("report_type").notNull(),
  format: text("format").notNull().default("json"), // json|csv|html
  status: text("status").notNull().default("pending"), // pending|processing|completed|failed|expired
  title: text("title").notNull(),
  dateRangeStart: timestamp("date_range_start"),
  dateRangeEnd: timestamp("date_range_end"),
  filters: jsonb("filters").$type<Record<string, unknown>>().default({}),
  fileName: text("file_name"),
  filePath: text("file_path"),                       // logical only; we store body inline
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  body: text("body"),                                // inline content (json/csv/html)
  rowCount: integer("row_count").default(0),
  downloadUrl: text("download_url"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("user_reports_user_idx").on(t.userId),
  typeIdx: index("user_reports_type_idx").on(t.reportType),
  statusIdx: index("user_reports_status_idx").on(t.status),
  createdIdx: index("user_reports_created_idx").on(t.createdAt),
}));
export type UserReport = typeof userReportsTable.$inferSelect;
export type InsertUserReport = typeof userReportsTable.$inferInsert;
