// Edge Library — production_edges (R7 step 6: edge library + promotion spine).
//
// One row per pre-registered, validation-backed edge contract. The row is the
// durable identity an edge carries from research to (an owner-pressed) live:
//
//   RESEARCH → SHADOW → DEMO → LIVE_CANDIDATE     (evaluatePromotion, pure gate)
//        any status ──────────→ RETIRED           (applyRetirement, one-way)
//
// THE InertModelVersion DOCTRINE (lib/discovery/src/pipeline.ts)
// --------------------------------------------------------------
// Rows are BORN INERT: every live gate defaults FALSE and the status defaults
// RESEARCH. Nothing in the discovery pipeline, the validation factory, or the
// promotion gate can set `liveAllowed` — that literal is the owner's press,
// out of code's authority (see edgePromotion.ts). A row that appears with any
// gate already true was not written by this system's promotion path.
//
// PROVENANCE, NOT TRUST
// ---------------------
//   preregHash — SHA-256 of the hypothesis spec from lib/discovery preRegister,
//     computed BEFORE any metric existed. A hypothesis invented after its
//     results is visible in the data, not a matter of trust.
//   reportHash — the lib/validation factory's hash-chained report hash. The
//     promotion gate REFUSES a report whose hash does not recompute, so a
//     validation result cannot be quietly restated after the fact.
//
// SAFETY: this table never places, sizes, or authorises a trade. It is a
// registry the promotion gate reads and (elsewhere, admin-gated) writes.
// Deterministic risk outranks everything here forever.
//
// MIGRATION IMPLICATION: new table — requires a drizzle-kit push (owner-run,
// per the no-raw-SQL-migrations rule for this wave; the Replit env points at
// production, so the push is the owner's press, not an agent action).
//
// REGISTRATION (coordinator): lib/db/src/schema/index.ts needs
//   export * from "./edgeLibrary";
// — index.ts is out of this implementer's scope.

import {
  pgTable, serial, text, boolean, timestamp, jsonb, index, doublePrecision,
  integer,
} from "drizzle-orm/pg-core";

// Promotion ladder. Order matters: the pure gate in
// artifacts/api-server/src/lib/learning/edgePromotion.ts only ever advances
// one rung at a time, and RETIRED is terminal (one-way, no re-entry).
export const PRODUCTION_EDGE_STATUSES = [
  "RESEARCH",
  "SHADOW",
  "DEMO",
  "LIVE_CANDIDATE",
  "RETIRED",
] as const;
export type ProductionEdgeStatus = (typeof PRODUCTION_EDGE_STATUSES)[number];

export const productionEdgesTable = pgTable("production_edges", {
  id:         serial("id").primaryKey(),
  name:       text("name").notNull(),                 // human-readable edge name
  versionTag: text("version_tag").notNull(),          // e.g. "edge_meanrev_v3"

  // ── Pre-registration (BEFORE any metric existed) ─────────────────────────
  // SHA-256 from lib/discovery preRegister(spec) — covers the spec ONLY,
  // never a result.
  preregHash: text("prereg_hash").notNull(),
  // The full pre-registered HypothesisSpec (familyKey, instrument, rule,
  // params, horizon, metric). Stored verbatim so the hash can be re-derived.
  specJson:   jsonb("spec_json").notNull(),

  // ── Validation evidence (lib/validation factory) ─────────────────────────
  // SignedValidationReport as produced by validateFamily. Null until a
  // validation run exists — and a null report can never clear RESEARCH.
  validationReportJson: jsonb("validation_report_json"),
  // The report's chained hash, denormalised for the gate's cross-check
  // (row hash must equal the embedded report hash, and both must recompute).
  reportHash: text("report_hash"),

  // ── Promotion ladder ──────────────────────────────────────────────────────
  // RESEARCH | SHADOW | DEMO | LIVE_CANDIDATE | RETIRED
  status: text("status").notNull().default("RESEARCH"),

  // ── Live gates — BORN FALSE, every one (InertModelVersion doctrine) ──────
  shadowValidated: boolean("shadow_validated").notNull().default(false),
  adminApproved:   boolean("admin_approved").notNull().default(false),
  // CONSTRAINT: no code path in this repo may set liveAllowed to true.
  // It is flipped only by the owner's own press on the admin surface that
  // does not exist yet — the default is the truth until then.
  liveAllowed:     boolean("live_allowed").notNull().default(false),

  // ── Foundation gate #23 — per-edge capacity (EDGE_CAPACITY_EXCEEDED) ─────
  // ALL additive + nullable. NULL capacityStatus = "no capacity estimate
  // recorded" — gate #23 then REFUSES capacity-governed LIVE entries (fail
  // closed, never a skipped cap).
  //
  //   capacityStatus — verbatim status literal from the campaign-3
  //     ruin/capacity simulator (lib/domain decision-intelligence
  //     ruinCapacitySimulation.engine.ts estimateStrategyCapacity):
  //     "ESTIMATED" | "NO_SAFE_CAPACITY" | "DEGENERATE_INPUT". Only
  //     "ESTIMATED" can admit deployment (allow-list; anything else refuses).
  //   capacityRiskR — the simulator's raw capacityRiskR output, stored for
  //     audit alongside the pressed ceiling; the gate does NOT convert it.
  //   capacityMaxDeployedUsd — the OWNER/ADMIN-pressed cumulative USD
  //     deployable ceiling recorded together with the estimate. The simulator
  //     never writes this number itself (the flywheel invariant: learned
  //     outputs may only refuse, never set a size); an estimate without a
  //     pressed ceiling admits nothing.
  //   capacityDeployCapOverrideUsd — optional owner tighten-only override;
  //     gate #23 takes min(ceiling, override) so it can only LOWER capacity.
  //   capacityEvidenceJson — the estimator's probes/reasons + the simulator
  //     base input, so the recorded estimate can be re-derived and audited.
  //   capacityEstimatedAt / capacityRecordedByAdminId — provenance of the press.
  capacityStatus: text("capacity_status"),
  capacityRiskR: doublePrecision("capacity_risk_r"),
  capacityMaxDeployedUsd: doublePrecision("capacity_max_deployed_usd"),
  capacityDeployCapOverrideUsd: doublePrecision("capacity_deploy_cap_override_usd"),
  capacityEvidenceJson: jsonb("capacity_evidence_json"),
  capacityEstimatedAt: timestamp("capacity_estimated_at", { withTimezone: true }),
  capacityRecordedByAdminId: integer("capacity_recorded_by_admin_id"),

  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),  // last rung advance
  retiredAt:  timestamp("retired_at", { withTimezone: true }),   // set once, never cleared
}, (t) => ({
  statusIdx:     index("pe_status_idx").on(t.status),
  versionTagIdx: index("pe_version_tag_idx").on(t.versionTag),
  preregIdx:     index("pe_prereg_hash_idx").on(t.preregHash),
}));

export type ProductionEdgeRow = typeof productionEdgesTable.$inferSelect;
export type ProductionEdgeInsert = typeof productionEdgesTable.$inferInsert;
