// Phase TU — Bridge capability disclosure.
//
// The MT5 EA reports its supported actions on heartbeat. The backend stores
// the report on `mt5_connection.capabilities` (jsonb). This module owns the
// type, defaults, and the helper that resolves a user's current capability +
// connection-state into one of the honest pending-order statuses surfaced by
// the submit-draft endpoint and the AI assistant.
//
// SAFETY:
//   * The schema-default `capabilities = NULL` means "legacy / no upgrade
//     reported" and must be treated as all-false. Pending-order submission
//     returns BRIDGE_UNSUPPORTED.
//   * `capabilities.pendingOrders = true` ONLY removes the BRIDGE_UNSUPPORTED
//     status — it never bypasses `queueMt5CommandWithGate`, the paper-only
//     lock, or any other guard. Real broker placement remains gated by the
//     existing Phase-12 safety chain.
//   * The set of capability keys is closed (see CAPABILITY_KEYS). Unknown
//     keys are dropped; this prevents EA-side typos from accidentally
//     "enabling" anything.

// Trade-action capabilities (Phase TU). Describe which order operations the EA
// can physically perform. Removing one only ever surfaces an honest "not
// supported" status — it never enables execution.
export const TRADE_CAPABILITY_KEYS = [
  "marketOrders",
  "marketOrderSLTP",
  "pendingOrders",
  "stopLimitOrders",
  "modifyPositionProtection",
  "modifyPendingOrders",
  "cancelPendingOrders",
  "expiration",
  "sharedMasterSafeRouting",
] as const;

// Feature capabilities (Task #32). Describe which *program features* the
// installed EA build supports. ARX only calls a feature the EA reports as
// supported; an unsupported feature surfaces an admin warning and is NEVER
// called or faked as ready. Adding a key here is additive — a legacy EA that
// does not report it normalises to false (= legacy / unsupported), exactly the
// behaviour we want.
export const FEATURE_CAPABILITY_KEYS = [
  "supportsCloseFillPrice",
  "supportsDealHistorySync",
  "supportsSelfUpdate",
  "supportsRemoteConfig",
  "supportsCommandTtl",
  "supportsExactlyOnce",
  "supportsSymbolCapabilities",
  "supportsEmergencyClose",
  "supportsTokenRotation",
  "supportsWatchdog",
  "supportsLiveTestCycle",
] as const;

export const CAPABILITY_KEYS = [
  ...TRADE_CAPABILITY_KEYS,
  ...FEATURE_CAPABILITY_KEYS,
] as const;

export type CapabilityKey = typeof CAPABILITY_KEYS[number];
export type FeatureCapabilityKey = typeof FEATURE_CAPABILITY_KEYS[number];

export type BridgeCapabilities = Record<CapabilityKey, boolean>;

// Derived from CAPABILITY_KEYS so it can never drift out of sync with the key
// set. Every key defaults to false (legacy / unsupported).
export const ALL_FALSE_CAPABILITIES: BridgeCapabilities = Object.freeze(
  Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false])),
) as BridgeCapabilities;

/**
 * Normalise an unknown EA-reported capabilities payload into the closed
 * BridgeCapabilities shape. Unknown keys are dropped; missing keys default
 * to false; non-boolean values become false.
 */
export function normaliseCapabilities(raw: unknown): BridgeCapabilities {
  const out = { ...ALL_FALSE_CAPABILITIES };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of CAPABILITY_KEYS) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}

// ─── Task #32 — feature capability gate ──────────────────────────────────────
//
// ARX must only ever call an EA feature the installed build reports as
// supported. A feature that is NOT supported surfaces an admin warning and is
// never called or faked as ready. NULL/legacy capabilities normalise to
// all-false, so a legacy EA is treated as supporting nothing new — the safe
// default.

export type FeatureGateStatus = "SUPPORTED" | "UNSUPPORTED_ADMIN_WARNING";

/**
 * True only when the connected EA explicitly reported this feature capability
 * as true. NULL/legacy/unknown all resolve to false.
 */
export function isFeatureSupported(
  caps: BridgeCapabilities | null | undefined,
  key: FeatureCapabilityKey,
): boolean {
  const c = caps ?? ALL_FALSE_CAPABILITIES;
  return c[key] === true;
}

/**
 * Resolve a feature into a gate status. Callers MUST refuse to invoke the
 * feature unless this returns "SUPPORTED"; "UNSUPPORTED_ADMIN_WARNING" means
 * show the operator a warning and do NOT call (and never report it as ready).
 */
export function featureGateStatus(
  caps: BridgeCapabilities | null | undefined,
  key: FeatureCapabilityKey,
): FeatureGateStatus {
  return isFeatureSupported(caps, key) ? "SUPPORTED" : "UNSUPPORTED_ADMIN_WARNING";
}

/**
 * Build a full feature-support map for every FEATURE_CAPABILITY_KEYS entry.
 * Used by admin surfaces to render per-feature SUPPORTED / warning badges
 * without re-deriving the gate per feature.
 */
export function featureSupportMatrix(
  caps: BridgeCapabilities | null | undefined,
): Record<FeatureCapabilityKey, FeatureGateStatus> {
  const out = {} as Record<FeatureCapabilityKey, FeatureGateStatus>;
  for (const key of FEATURE_CAPABILITY_KEYS) {
    out[key] = featureGateStatus(caps, key);
  }
  return out;
}

/**
 * Honest pending-order submission status. The submit endpoint returns
 * exactly one of these and updates the draft row's `pendingStatus` to the
 * same value. NEVER returns a "success" or "filled" string from this layer.
 */
export type PendingSubmitStatus =
  | "BRIDGE_DISCONNECTED"
  | "BRIDGE_UNSUPPORTED"
  | "BLOCKED_BY_PAPER_LOCK"
  | "BLOCKED_BY_RISK"
  | "READ_ONLY"
  | "LIVE_LOCKED"
  | "TRADING_DISABLED"          // reserved — emitted by callers that observe a tradingDisabled flag
  | "EA_UPGRADE_REQUIRED"       // alias surfaced when EA missing pending-order support
  | "QUEUED";  // reserved — never returned today; future when paper-lock lifts

export interface CapabilityResolution {
  capabilities: BridgeCapabilities;
  bridgeConnected: boolean;
  paperOnlyLock: boolean;
  liveLocked: boolean;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
  eaVersion: string | null;
  capabilitiesReportedAt: string | null;
  /**
   * Whether the bridge could *theoretically* execute a pending order if every
   * other guard passed. Today this is always false because the paper-only
   * lock forces every queued command to BLOCKED. Reported honestly here so
   * the UI/AI can explain WHY without lying.
   */
  pendingOrderExecutable: boolean;
}

/**
 * Compute the honest blocking status for a pending-order submission attempt.
 * Returns null only in the (currently unreachable) case where everything
 * passes — at which point the caller would enqueue. Today the paper-only
 * lock guarantees this returns BLOCKED_BY_PAPER_LOCK whenever capability +
 * connection are otherwise fine.
 */
export function resolvePendingSubmitStatus(args: {
  capabilities: BridgeCapabilities | null | undefined;
  bridgeConnected: boolean;
  needsStopLimit: boolean;
  paperOnlyLock: boolean;
  liveLocked: boolean;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
}): PendingSubmitStatus {
  if (!args.bridgeConnected) return "BRIDGE_DISCONNECTED";
  const caps = args.capabilities ?? ALL_FALSE_CAPABILITIES;
  if (!caps.pendingOrders) return "BRIDGE_UNSUPPORTED";
  if (args.needsStopLimit && !caps.stopLimitOrders) return "BRIDGE_UNSUPPORTED";
  if (args.readOnlyMode) return "READ_ONLY";
  if (args.liveLocked) return "LIVE_LOCKED";
  if (!args.allowOrderExecution) return "BLOCKED_BY_PAPER_LOCK";
  if (args.paperOnlyLock) return "BLOCKED_BY_PAPER_LOCK";
  // Future state: when paper-lock lifts AND risk governor passes, the caller
  // enqueues. Caller is responsible for that final hop.
  return "QUEUED";
}

export function explainStatus(status: PendingSubmitStatus): string {
  switch (status) {
    case "BRIDGE_DISCONNECTED":
      return "Your MT5 bridge has not sent a heartbeat recently. Reconnect the EA before submitting a pending order.";
    case "BRIDGE_UNSUPPORTED":
      return "The connected EA does not report support for pending-order execution. Install or update the ARX AI Bridge EA (v1.40+).";
    case "READ_ONLY":
      return "Your MT5 connection is in read-only mode. Pending-order submission is disabled.";
    case "LIVE_LOCKED":
      return "Live execution is locked for this account. Pending-order submission is disabled.";
    case "BLOCKED_BY_PAPER_LOCK":
      return "ARX AI is paper-only by construction. The submitted draft is saved, but the queue gate refuses to deliver it to the broker.";
    case "BLOCKED_BY_RISK":
      return "Your risk governor blocked this submission. Adjust the ticket or risk settings.";
    case "TRADING_DISABLED":
      return "Trading is disabled for this account. Pending-order submission is disabled.";
    case "EA_UPGRADE_REQUIRED":
      return "The connected EA does not yet implement pending-order execution. Install or update the ARX AI Bridge EA (v1.40+).";
    case "QUEUED":
      return "Submitted to the broker queue. Awaiting EA confirmation.";
  }
}
