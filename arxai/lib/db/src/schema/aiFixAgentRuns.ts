// ── Task #705 — Claude Backend Fix Agent run ledger ─────────────────────────
//
// SAFETY / SCOPE:
//   - ADVISORY + DIAGNOSTIC ONLY. An ai_fix_agent_runs row records an
//     admin-initiated backend-error diagnosis or a DRY-RUN patch proposal made
//     by the Claude Backend Fix Agent. It is append-only evidence — it NEVER
//     places/approves a trade, mutates bridge state, overrides a risk gate or
//     the kill switch, marks anything broker-confirmed, or touches the 18-gate
//     live pipeline.
//   - The agent never applies a patch in this build. `dryRun` is always true and
//     `applied` is always false; an APPLY path is intentionally not implemented.
//   - Inputs are REDACTED before persistence (secrets/keys/tokens/connection
//     strings/emails/phones stripped, size-capped). Raw secrets never land here.
//   - Admin-only surface: every read/write is performed by an ADMIN/OWNER
//     session; there is no per-user fan-out.

import {
  pgTable, serial, integer, text, jsonb, boolean, timestamp, index,
} from "drizzle-orm/pg-core";

export const aiFixAgentRunsTable = pgTable("ai_fix_agent_runs", {
  id:             serial("id").primaryKey(),

  // Who initiated (admin/owner). adminRole is the EFFECTIVE role at call time.
  adminId:        integer("admin_id"),
  adminRole:      text("admin_role").notNull(),

  // "diagnose" | "propose_patch"
  mode:           text("mode").notNull(),

  // Free-form backend area hint the admin selected (e.g. "mt5_bridge",
  // "live_pipeline", "market_data", "api_routes", "database", "other").
  area:           text("area"),

  // Provider/model actually used.
  provider:       text("provider").notNull(),
  model:          text("model").notNull(),

  // Always true / always false in this build — an APPLY path is not implemented.
  dryRun:         boolean("dry_run").notNull().default(true),
  applied:        boolean("applied").notNull().default(false),

  // "completed" | "failed" | "blocked"
  status:         text("status").notNull(),

  // REDACTED request snapshot (area, capped/redacted error+context+logs).
  inputRedacted:  jsonb("input_redacted").notNull().default({}),

  // Structured model output (diagnosis or dry-run patch proposal).
  output:         jsonb("output"),

  // Populated when status != "completed".
  errorReason:    text("error_reason"),

  // Best-effort token usage + latency telemetry.
  inputTokens:    integer("input_tokens"),
  outputTokens:   integer("output_tokens"),
  latencyMs:      integer("latency_ms"),

  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  adminIdx:   index("ai_fix_agent_runs_admin_idx").on(t.adminId),
  modeIdx:    index("ai_fix_agent_runs_mode_idx").on(t.mode),
  createdIdx: index("ai_fix_agent_runs_created_idx").on(t.createdAt),
}));

export type AiFixAgentRunRow = typeof aiFixAgentRunsTable.$inferSelect;
export type AiFixAgentRunInsert = typeof aiFixAgentRunsTable.$inferInsert;
