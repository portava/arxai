// Canonical MT5 bridge mode enum. Single source of truth shared by server
// and dashboard. Browser-safe (no Node imports, no IO).
//
// Behavior contract:
//   - OFFLINE       — no MT5 connection or stale heartbeat. Default/fallback.
//   - READ_ONLY     — bridge is connected but command placement is disabled
//                     (force-BLOCKED today; observation-only).
//   - PAPER_ONLY    — paper/demo account routing; safe to send paper orders.
//   - LIVE_LOCKED   — live capable in principle, but operator/system lock
//                     prevents live order placement.
//
// SAFETY: this enum is contract-only. It does NOT unlock any execution
// path. Live trading remains BLOCKED, auto-close remains ALERT_ONLY,
// shared MT5 routing remains BLOCKED, MT5 commands remain force-BLOCKED.

export type CanonicalBridgeMode =
  | "OFFLINE"
  | "READ_ONLY"
  | "PAPER_ONLY"
  | "LIVE_LOCKED";

export const CANONICAL_BRIDGE_MODES: readonly CanonicalBridgeMode[] = [
  "OFFLINE",
  "READ_ONLY",
  "PAPER_ONLY",
  "LIVE_LOCKED",
] as const;

export const DEFAULT_BRIDGE_MODE: CanonicalBridgeMode = "OFFLINE";

/** Inputs accepted by `mapLegacyBridgeMode`. */
export type LegacyBridgeMode =
  | "connected"
  | "disconnected"
  | "deferred"
  | "simulator"
  | "unknown"
  | "MOCK"
  | "DEMO"
  | "LIVE_LOCKED"
  | "OFFLINE"
  | "READ_ONLY"
  | "PAPER_ONLY"
  | string
  | null
  | undefined;

/**
 * Map any legacy / heterogeneous bridge-mode string into the canonical
 * 4-value enum. Defaults to OFFLINE for unknown / stale / missing inputs
 * so callers never accidentally treat "unknown" as healthy.
 *
 * Mapping rationale (current system invariants):
 *  - "connected" alone is reported as READ_ONLY because shared MT5
 *    command placement is force-BLOCKED. Real order placement remains
 *    impossible regardless of this value.
 *  - "MOCK" / "DEMO" map to PAPER_ONLY (paper routing semantics).
 *  - "deferred" / "simulator" / "unknown" / null / unknown strings all
 *    collapse to OFFLINE.
 */
export function mapLegacyBridgeMode(input: LegacyBridgeMode): CanonicalBridgeMode {
  if (input == null) return "OFFLINE";
  switch (input) {
    case "OFFLINE":
    case "READ_ONLY":
    case "PAPER_ONLY":
    case "LIVE_LOCKED":
      return input;
    case "connected":
      return "READ_ONLY";
    case "MOCK":
    case "DEMO":
      return "PAPER_ONLY";
    case "disconnected":
    case "deferred":
    case "simulator":
    case "unknown":
      return "OFFLINE";
    default:
      return "OFFLINE";
  }
}

/**
 * Apply heartbeat-staleness rule. Per the contract, a stale heartbeat
 * MUST force OFFLINE regardless of the upstream reported mode.
 */
export function applyHeartbeatStaleness(
  mode: CanonicalBridgeMode,
  heartbeatStale: boolean,
): CanonicalBridgeMode {
  if (heartbeatStale) return "OFFLINE";
  return mode;
}
