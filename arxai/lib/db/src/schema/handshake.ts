// ── ARX Handshake System — check-in evidence (Phase 0) ──────────────────────
//
// Append-only log of handshake outcomes. This is operator-facing EVIDENCE for
// the System Handshake Monitor — it is ADVISORY and NOT on any execution hot
// path. The handshake never gates a trade; this table only records what the
// coordinator observed. Rows are evidence — never auto-deleted.

import { pgTable, serial, text, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const handshakeCheckinsTable = pgTable(
  "handshake_checkins",
  {
    id: serial("id").primaryKey(),
    // HandshakeType (domain enum) — stored as text, validated in the domain.
    handshakeType: text("handshake_type").notNull(),
    // HandshakeOverallStatus: PASS | WARN | BLOCK | UNKNOWN.
    overall: text("overall").notNull(),
    // Operator-facing reason strings (never user-facing copy).
    blockingReasons: jsonb("blocking_reasons").notNull().default([]),
    warnings: jsonb("warnings").notNull().default([]),
    // Full per-layer checks snapshot (HandshakeLayerCheck[]).
    checks: jsonb("checks").notNull().default([]),
    // Whether this handshake type has real adapters (vs. planned scaffold).
    implemented: boolean("implemented").notNull().default(false),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeIdx: index("handshake_checkins_type_idx").on(t.handshakeType),
    createdIdx: index("handshake_checkins_created_idx").on(t.createdAt),
  }),
);

export type HandshakeCheckin = typeof handshakeCheckinsTable.$inferSelect;
export type HandshakeCheckinInsert = typeof handshakeCheckinsTable.$inferInsert;
