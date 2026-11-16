// Canonical reconciliation status enum. Single source of truth shared by
// server (`getReconciliationStatus` AI tool, executionReconciler) and
// dashboard. Browser-safe (no Node imports, no IO).
//
// SAFETY: this enum is contract-only. Adding canonical values does NOT
// trigger any reconciliation action, does NOT execute trades, does NOT
// modify live_positions / mt5_commands. Shared MT5 routing remains
// BLOCKED at the placement layer.

export type CanonicalReconciliationStatus =
  | "MATCHED"
  | "APP_ONLY"
  | "BROKER_ONLY"
  | "MISMATCHED"
  | "ATTRIBUTION_MISSING"
  | "STALE_BROKER_DATA"
  | "BRIDGE_OFFLINE"
  | "RECONCILIATION_BLOCKED";

export const CANONICAL_RECONCILIATION_STATUSES: readonly CanonicalReconciliationStatus[] = [
  "MATCHED",
  "APP_ONLY",
  "BROKER_ONLY",
  "MISMATCHED",
  "ATTRIBUTION_MISSING",
  "STALE_BROKER_DATA",
  "BRIDGE_OFFLINE",
  "RECONCILIATION_BLOCKED",
] as const;

/** Pre-existing literals emitted by `getReconciliationStatus` today. */
export type LegacyReconciliationStatus =
  | "BRIDGE_OFFLINE"
  | "RECONCILIATION_BLOCKED"
  | "ATTRIBUTION_INCOMPLETE"
  | "MATCHED"
  | "NO_ROUTED_TRADES"
  | "MATCHED_ALL"
  | string;

/**
 * Map any legacy reconciliation literal into the canonical 8-value enum.
 * Backward compatibility: every legacy value the codebase has ever emitted
 * is preserved into a sensible canonical bucket.
 *
 *   ATTRIBUTION_INCOMPLETE → ATTRIBUTION_MISSING
 *   NO_ROUTED_TRADES       → RECONCILIATION_BLOCKED (shared routing locked)
 *   MATCHED_ALL            → MATCHED
 *   BRIDGE_OFFLINE         → BRIDGE_OFFLINE
 *   RECONCILIATION_BLOCKED → RECONCILIATION_BLOCKED
 *   MATCHED                → MATCHED
 *   unknown                → RECONCILIATION_BLOCKED (fail-closed)
 */
export function mapLegacyReconciliationStatus(
  input: LegacyReconciliationStatus | null | undefined,
): CanonicalReconciliationStatus {
  if (input == null) return "RECONCILIATION_BLOCKED";
  switch (input) {
    case "MATCHED":
    case "APP_ONLY":
    case "BROKER_ONLY":
    case "MISMATCHED":
    case "ATTRIBUTION_MISSING":
    case "STALE_BROKER_DATA":
    case "BRIDGE_OFFLINE":
    case "RECONCILIATION_BLOCKED":
      return input;
    case "ATTRIBUTION_INCOMPLETE":
      return "ATTRIBUTION_MISSING";
    case "NO_ROUTED_TRADES":
      return "RECONCILIATION_BLOCKED";
    case "MATCHED_ALL":
      return "MATCHED";
    default:
      return "RECONCILIATION_BLOCKED";
  }
}
