// ═══════════════════════════════════════════════════════════════════════════
// Event-Sourced Black Box Vault — pure types.
//
// Defines the immutable AuditEvent record that backs the parallel audit
// layer. Every required field from the spec is present:
// eventId / timestamp / eventType / source / severity / systemMode /
// globalState / payload / previousEventId / checksum / schemaVersion.
// ═══════════════════════════════════════════════════════════════════════════

export const AUDIT_SCHEMA_VERSION = 1 as const;

export type AuditSeverity = "INFO" | "WARN" | "DANGER" | "CRITICAL";

export type VaultMode = "SHADOW_MODE" | "ACTIVE_MODE";

// Whitelist of important event types the shadow vault must capture. Free-form
// strings are accepted, but anything in this list is considered "core" and is
// validated by integrity scans.
export const CORE_EVENT_TYPES = [
  "MODE_CHANGE",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_RESET",
  "STATE_TRANSITION",
  "TRADE_GATE",
  "TRADE_APPROVED",
  "TRADE_BLOCKED",
  "TRADE_REJECTED",
  "TRADE_PAPER",
  "TRADE_SIMULATED",
  "RISK_DECISION",
  "RECOVERY",
  "MT5_DISCONNECT",
  "LATENCY_SPIKE",
  "SPREAD_CHANGE",
  "USER_OVERRIDE",
  "VAULT_CORRECTION",
] as const;
export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];

export interface AuditEvent {
  /** Globally unique, monotonic. */
  eventId: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  /** Free-form, but core types should appear in CORE_EVENT_TYPES. */
  eventType: string;
  /** Producing subsystem: CONTROL_TOWER, RISK_GOVERNOR, KILL_SWITCH, ... */
  source: string;
  severity: AuditSeverity;
  /** Operational mode at emit time (OBSERVE_ONLY / .. / LIVE_TRADING). */
  systemMode: string | null;
  /** Global state at emit time (NORMAL / SAFE_SHUTDOWN / ...). */
  globalState: string | null;
  /** Caller-defined structured detail. Must be JSON-serializable. */
  payload: Record<string, unknown>;
  /** Hash-pointer to the prior event in the chain, or null if first. */
  previousEventId: string | null;
  /** Hex-encoded checksum (typically sha256) of the canonical event body. */
  checksum: string;
  schemaVersion: number;
  /** Top-level training-eligibility flag (Phase 2 spec). The DataQualityGuard
   *  pipeline computes this; events with bad payload / poison signals / guard
   *  errors are stored with trainingEligible=false so future AI can never
   *  consume them as memory. Stored as a side-car field — NOT checksummed,
   *  so it does not break verification of pre-existing v1 chain rows. */
  trainingEligible: boolean;
}

/** Caller-supplied data — store/chain engines fill in id/checksum/prev. */
export interface AuditEventDraft {
  eventType: string;
  source: string;
  severity: AuditSeverity;
  systemMode: string | null;
  globalState: string | null;
  payload?: Record<string, unknown>;
  /** Optional explicit timestamp; defaults to now via clock port. */
  timestamp?: string;
  /** Optional eligibility hint; sealEvent defaults to true if omitted, then
   *  the guard pipeline overrides to the computed verdict before persistence. */
  trainingEligible?: boolean;
}

/** A correction is itself an event that points to the corrected event id. */
export interface AuditCorrectionDraft extends AuditEventDraft {
  correctsEventId: string;
  reason: string;
}
