// ── ARX Handshake System — pure domain contract ─────────────────────────────
//
// The Handshake System is a SHARED, CROSS-LAYER READINESS / CHECK-IN backbone.
// It READS the state of existing subsystems ("layers") and aggregates a single
// advisory verdict so any flow can ask "is everything I depend on ready?".
//
// INVIOLABLE DESIGN:
// - ADVISORY ONLY. A handshake NEVER gates, slows, or blocks any execution
//   path. It is not a new gate in the 16-gate live pipeline, not a kill switch,
//   not a trade precondition. Downstream consumers may surface its verdict, but
//   the authoritative gates (16-gate evaluator, kill switch, per-user approval)
//   remain the only things that can stop a trade.
// - READ-ONLY. Layer adapters only read existing services/tables. No mutation,
//   no dispatch, no order placement.
// - HONEST. When a layer cannot be read, the verdict is NOT_AVAILABLE / UNKNOWN
//   — never a fabricated PASS, never sim/mock/placeholder data.
//
// This file is pure types + enums. No IO, no DB, no HTTP.

// A "layer" is an existing subsystem the handshake reads (READ-ONLY).
export const HANDSHAKE_LAYER_KEYS = [
  "MARKET_DATA",
  "BROKER_BRIDGE",
  "NEWS",
  "SCANNER",
  "INVESTOR_FUND_BOOK",
  "ADMIN_CONTROL",
  "KILL_SWITCH",
  // ── Readiness layers wrapping existing read-only services ──
  // The Ruby explanation engine's data dependency (assistant market provider).
  "RUBY_EXPLANATION",
  // Smart-chart overlay / market-impact-radar drawing data source.
  "CHART_OVERLAY",
  // Pre-trade economics (spread / slippage / margin / ATR) preview readiness.
  "RISK_PREVIEW",
  // Trade-ticket prefill readiness (symbol resolution + account-mode).
  "TRADE_MODAL_PREFILL",
] as const;
export type HandshakeLayerKey = (typeof HANDSHAKE_LAYER_KEYS)[number];

// Per-layer readiness verdict (shared contract vocabulary).
// PASS          — signal present, fresh, healthy.
// WARN          — reachable but impaired (degraded provider / stale signal).
// FAIL          — a definitive bad state that should stop a dependent action
//                 (e.g. kill switch engaged, broker disconnected, open CRITICAL
//                 discrepancy). Advisory "do not proceed" hint, never a real gate.
// SKIPPED       — not applicable in the current context (e.g. an investor-scoped
//                 layer evaluated with no investor context).
// NOT_AVAILABLE — the layer's signal could not be read / is not configured.
//                 Honest unknown for that layer; never a fabricated PASS.
export const HANDSHAKE_LAYER_STATUSES = [
  "PASS",
  "WARN",
  "FAIL",
  "SKIPPED",
  "NOT_AVAILABLE",
] as const;
export type HandshakeLayerStatus = (typeof HANDSHAKE_LAYER_STATUSES)[number];

// Aggregated handshake verdict.
// PASS    — every required layer PASS.
// WARN    — required layers reachable but impaired, or an optional layer down.
// BLOCK   — a required layer FAIL/NOT_AVAILABLE (advisory "do not proceed" hint).
// UNKNOWN — nothing could be aggregated (honest; never fabricate a PASS).
export const HANDSHAKE_OVERALL_STATUSES = ["PASS", "WARN", "BLOCK", "UNKNOWN"] as const;
export type HandshakeOverallStatus = (typeof HANDSHAKE_OVERALL_STATUSES)[number];

// Richer, user-meaningful readiness verdict derived from the per-layer checks +
// freshness. This is the documented top-level status of a handshake result; the
// 4-value `HandshakeOverallStatus` aggregate is retained for back-compat and the
// `safeToProceed` flag. STILL ADVISORY — never a gate.
// READY               — all required layers PASS, fresh, healthy.
// READY_WITH_WARNINGS — required layers PASS; only optional layers impaired.
// WAITING_FOR_DATA    — a required input is not available yet (no fabrication).
// STALE               — a required time-based signal is impaired by staleness.
// DEGRADED            — a required layer is reachable but impaired (non-stale).
// BLOCKED             — a required layer is in a definitive bad state (advisory
//                       "do not proceed"; the REAL stop is the 16-gate pipeline).
// ERROR               — nothing could be evaluated (honest; never fabricate).
export const HANDSHAKE_READINESS_STATUSES = [
  "READY",
  "READY_WITH_WARNINGS",
  "WAITING_FOR_DATA",
  "STALE",
  "DEGRADED",
  "BLOCKED",
  "ERROR",
] as const;
export type HandshakeReadinessStatus = (typeof HANDSHAKE_READINESS_STATUSES)[number];

// Advisory capability descriptor attached to every handshake result. Purely
// informational — surfaces WHAT KIND of surface this handshake informs. It never
// grants or denies anything; authority stays with the real gates/role checks.
export interface HandshakePermissions {
  // The informed surface is admin/operator-only.
  adminOnly: boolean;
  // The result is scoped to a single investor's data (investor isolation).
  investorScoped: boolean;
  // The handshake informs an execution-critical action whose FINAL authority is
  // the real 16-gate live pipeline — this handshake NEVER authorizes execution.
  executionCritical: boolean;
}

// The cross-layer flows that perform a handshake. The first group is wired with
// real read-only adapters; the scaffold group is reserved for downstream phases
// (Ruby Market Edge) and runs no fabricated logic until implemented.
export const HANDSHAKE_TYPES = [
  // ── Infrastructure / layer-readiness handshakes ──
  "MARKET_DATA",
  "BROKER_BRIDGE",
  "NEWS",
  "INVESTOR_VALUE",
  "WEEKLY_REPORT",
  "ADMIN_FUND_CONTROL",
  "SIGNAL_INTELLIGENCE",
  "SCANNER_EXPLANATION",
  "EXECUTION_COST",
  "NEWS_RADAR",
  "TRADE_HEALTH",
  // ── Named end-to-end readiness handshakes (the 9 surfaces) ──
  "SMART_CHART_OVERLAY",
  "TRADE_PREVIEW",
  "RUBY_EXECUTION",
] as const;
export type HandshakeType = (typeof HANDSHAKE_TYPES)[number];

// The nine named, user-meaningful handshake surfaces this system guarantees,
// mapped to the concrete `HandshakeType` that evaluates each. Several reuse an
// existing infrastructure handshake type (no duplicate logic) — e.g. "Scanner
// Signal" is the SIGNAL_INTELLIGENCE handshake. This is the canonical list the
// admin monitor and tests exercise.
export const NAMED_HANDSHAKE_SURFACES: Readonly<Record<string, HandshakeType>> = {
  "Scanner Signal": "SIGNAL_INTELLIGENCE",
  "Smart Chart Overlay": "SMART_CHART_OVERLAY",
  "Trade Preview": "TRADE_PREVIEW",
  "Ruby Execution": "RUBY_EXECUTION",
  "Live Trade Health": "TRADE_HEALTH",
  "Investor Value": "INVESTOR_VALUE",
  "Weekly Report": "WEEKLY_REPORT",
  "Admin Fund Control": "ADMIN_FUND_CONTROL",
  "Ruby Explanation": "SCANNER_EXPLANATION",
} as const;

// Handshake types that inform an EXECUTION-CRITICAL action. Their advisory
// "BLOCKED" verdict is only a surfaced hint; the authoritative stop is ALWAYS
// the real 16-gate live pipeline. These are NEVER a 17th gate.
export const EXECUTION_CRITICAL_HANDSHAKE_TYPES: readonly HandshakeType[] = [
  "TRADE_PREVIEW",
  "RUBY_EXECUTION",
] as const;

// The handshake types that read per-investor data and therefore REQUIRE an
// investor context. Evaluated without that context they return SKIPPED rather
// than leak or fabricate another tenant's data.
export const INVESTOR_SCOPED_HANDSHAKE_TYPES: readonly HandshakeType[] = [
  "INVESTOR_VALUE",
  "WEEKLY_REPORT",
] as const;

// Context passed into a handshake run. Enforces per-investor isolation: an
// investor-scoped handshake reads ONLY the supplied investor's rows. The
// coordinator never widens this scope, and investor payloads never expose the
// ARX 60/40 waterfall, trader comp, or another tenant's data.
export interface HandshakeContext {
  // The investor (user) whose data an investor-scoped handshake may read.
  investorUserId?: number | null;
  // The user whose per-user execution surface (trade preview / Ruby execution /
  // risk preview / ticket prefill) is being evaluated. Without it, those
  // per-user layers report SKIPPED rather than fabricate or leak — the system
  // (admin) monitor view never supplies one.
  userId?: number | null;
  // True when the caller is an ADMIN/OWNER operator (admin monitor view).
  isAdmin?: boolean;
}

// One layer's contribution to a handshake.
export interface HandshakeLayerCheck {
  layer: HandshakeLayerKey;
  status: HandshakeLayerStatus;
  // Whether this layer is required for the handshake to PASS.
  required: boolean;
  // Operator-facing detail (never user-facing copy). Short, no secrets.
  detail: string;
  // Age of the underlying signal in ms when known (null = not time-based).
  ageMs: number | null;
}

// Freshness summary across a handshake's checks (advisory; distinct from the
// authoritative 15s dispatch heartbeat gate).
export interface HandshakeFreshness {
  // ISO timestamp of this evaluation.
  evaluatedAt: string;
  // Oldest known per-layer signal age in ms (null = none time-based / known).
  oldestSignalAgeMs: number | null;
  // True when any reachable layer is impaired by staleness.
  hasStaleSignal: boolean;
}

// The aggregated outcome of a single handshake run (shared standard result).
export interface HandshakeResult {
  type: HandshakeType;
  // The documented, user-meaningful readiness verdict (rich 7-value enum).
  overallStatus: HandshakeReadinessStatus;
  // The 4-value aggregate verdict retained for back-compat / `safeToProceed`.
  aggregateStatus: HandshakeOverallStatus;
  // Convenience advisory flag: true when there are no blockers and the aggregate
  // is not UNKNOWN. NEVER consulted by any execution gate.
  safeToProceed: boolean;
  // Per-layer checks (operator-facing). `layersChecked` is the documented alias.
  checks: HandshakeLayerCheck[];
  layersChecked: HandshakeLayerCheck[];
  // Reasons that forced a BLOCK verdict (operator-facing).
  blockers: string[];
  // Reasons that forced a WARN verdict (operator-facing).
  warnings: string[];
  // Freshness summary across the layer checks.
  freshness: HandshakeFreshness;
  // Advisory capability descriptor for the informed surface (never authority).
  permissions: HandshakePermissions;
  // Clean, user-safe next-step suggestions (no internal wording). May be empty.
  recommendations: string[];
  // Clean, generic message safe to surface to end users (no internal wording).
  userFacingMessage: string;
  // Operator-facing detail (admin monitor only; may name layers/reasons).
  adminDetails: string;
  // True when this handshake type has real layer adapters wired.
  implemented: boolean;
  // ISO timestamp of evaluation.
  evaluatedAt: string;
}
