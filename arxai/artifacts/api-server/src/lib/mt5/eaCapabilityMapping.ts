// Phase T033 — EA v1.50 → backend capability mapping layer.
//
// PROBLEM this solves (from the v1.50 compliance audit):
//   The EA v1.50 reports a richer, differently-named capability vocabulary
//   (openMarket, partialClose, validateOnly, symbolDiscovery, …). The backend's
//   closed CAPABILITY_KEYS set (bridgeCapabilities.ts) silently DROPS any key
//   it does not recognise — so every v1.50 capability was being discarded and
//   the new EA power stayed dark.
//
// DESIGN (intentionally non-destructive):
//   * EA v1.50 capability keys are left UNCHANGED (no EA redesign).
//   * Existing backend `supportsX` / trade-capability keys are left UNCHANGED
//     (no break to v1.40 behaviour or existing UI gating).
//   * This module is a pure TRANSLATION + PRESERVATION layer:
//       - normaliseEaCapabilities() maps EA keys → backend keys
//       - it ALSO accepts backend-style `supportsX` keys reported directly
//         (alias passthrough), so either vocabulary works
//       - raw EA capabilities are preserved verbatim for admin diagnostics
//       - unknown keys are preserved in raw, but NEVER auto-enable a feature
//
// SAFETY:
//   * Unknown / missing / non-boolean keys default to false.
//   * Translation only ever sets a normalized key true when the EA explicitly
//     reported the corresponding capability true. It cannot enable execution;
//     it only lets ARX stop hiding a feature the EA says it supports. Every
//     real order still passes the existing guard chain.

import {
  CAPABILITY_KEYS,
  ALL_FALSE_CAPABILITIES,
  normaliseCapabilities,
  type BridgeCapabilities,
} from "./bridgeCapabilities.js";

// ─── Normalized backend capability keys introduced for v1.50 ────────────────
// These are the `supportsX` names the rest of ARX (backend gates + frontend
// feature gating) will read. They are ADDITIVE: a legacy EA that never reports
// them normalises to false, exactly the safe default.
export const V150_NORMALIZED_KEYS = [
  "supportsMarketOrders",
  "supportsPendingOrders",
  "supportsModifySLTP",
  "supportsModifyPendingOrders",
  "supportsCancelPendingOrders",
  "supportsClosePosition",
  "supportsPartialClose",
  "supportsReverse",
  "supportsBreakEven",
  "supportsTrailingStop",
  "supportsSymbolDiscovery",
  "supportsBrokerRules",
  "supportsValidateOnly",
  "supportsAccountSnapshots",
  "supportsOpenPositionSync",
  "supportsPendingOrderSync",
  "supportsManualMT5Detection",
  "supportsStructuredErrors",
  "supportsEmergencyClose",
  "supportsRemoteConfig",
  "supportsCommandIdempotency",
  "supportsMagicCommentTagging",
  "supportsTelemetry",
] as const;

export type V150NormalizedKey = typeof V150_NORMALIZED_KEYS[number];
export type NormalizedCapabilities = Record<V150NormalizedKey, boolean>;

export const ALL_FALSE_NORMALIZED: NormalizedCapabilities = Object.freeze(
  Object.fromEntries(V150_NORMALIZED_KEYS.map((k) => [k, false])),
) as NormalizedCapabilities;

// ─── EA v1.50 key → backend normalized key ──────────────────────────────────
// Source vocabulary is exactly what ARX_AI_Universal_Agent_v150.mq5 emits.
const EA_TO_NORMALIZED: Record<string, V150NormalizedKey> = {
  openMarket:           "supportsMarketOrders",
  placePending:         "supportsPendingOrders",
  pendingOrders:        "supportsPendingOrders",       // EA also emits this legacy key
  modifyPosition:       "supportsModifySLTP",
  moveSL:               "supportsModifySLTP",
  moveTP:               "supportsModifySLTP",
  modifyPositionProtection: "supportsModifySLTP",      // legacy key alias
  modifyPending:        "supportsModifyPendingOrders",
  modifyPendingOrders:  "supportsModifyPendingOrders", // legacy alias
  cancelPending:        "supportsCancelPendingOrders",
  cancelPendingOrders:  "supportsCancelPendingOrders", // legacy alias
  closePosition:        "supportsClosePosition",
  partialClose:         "supportsPartialClose",
  reversePosition:      "supportsReverse",
  reverse:              "supportsReverse",
  breakEven:            "supportsBreakEven",
  trailingStop:         "supportsTrailingStop",
  symbolDiscovery:      "supportsSymbolDiscovery",
  symbolRules:          "supportsBrokerRules",
  symbolResolver:       "supportsBrokerRules",
  validateOnly:         "supportsValidateOnly",
  accountSnapshot:      "supportsAccountSnapshots",
  openPositionSync:     "supportsOpenPositionSync",
  pendingOrderSync:     "supportsPendingOrderSync",
  manualTradeDetection: "supportsManualMT5Detection",
  structuredErrors:     "supportsStructuredErrors",
  emergencyClose:       "supportsEmergencyClose",
  panicCloseAll:        "supportsEmergencyClose",
  closeAllBySymbol:     "supportsEmergencyClose",
  closeAllByMagic:      "supportsEmergencyClose",
  remoteConfig:         "supportsRemoteConfig",
  commandIdempotency:   "supportsCommandIdempotency",
  magicCommentTagging:  "supportsMagicCommentTagging",
  telemetry:            "supportsTelemetry",
  marketTelemetryIndicators: "supportsTelemetry",
};

// A normalized key reported DIRECTLY by the EA (supportsX vocabulary) is also
// honoured — so if the EA protocol ever adopts the backend names, it keeps
// working without a code change here.
const DIRECT_NORMALIZED = new Set<string>(V150_NORMALIZED_KEYS);

export interface CapabilityIngest {
  /** Raw EA-reported capabilities, verbatim, for admin diagnostics. */
  rawEaCapabilities: Record<string, unknown>;
  /** Backend-normalized supportsX capability map (closed key set). */
  normalizedCapabilities: NormalizedCapabilities;
  /** Legacy closed-set capabilities (v1.40 keys) — preserved for existing UI. */
  legacyCapabilities: BridgeCapabilities;
  /** Keys the EA sent that we could not map (preserved, never auto-enabled). */
  unmappedKeys: string[];
  eaName: string | null;
  eaVersion: string | null;
  eaBuild: string | null;
  eaProtocol: string | null;
  lastCapabilitySeenAt: string;
}

/**
 * Translate an EA capability payload (either vocabulary) into the backend's
 * normalized capability map, while preserving the raw payload and the legacy
 * closed-set capabilities. Pure function — no I/O.
 */
export function ingestEaCapabilities(raw: unknown, eaMeta?: {
  eaName?: unknown; eaVersion?: unknown; build?: unknown; protocol?: unknown;
}): CapabilityIngest {
  const normalized: NormalizedCapabilities = { ...ALL_FALSE_NORMALIZED };
  const rawObj: Record<string, unknown> =
    raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};

  const knownEaKeys = new Set(Object.keys(EA_TO_NORMALIZED));
  const unmapped: string[] = [];

  for (const [key, val] of Object.entries(rawObj)) {
    if (typeof val !== "boolean") continue; // non-booleans never enable
    if (DIRECT_NORMALIZED.has(key)) {
      // EA reported a backend-style key directly.
      normalized[key as V150NormalizedKey] = val || normalized[key as V150NormalizedKey];
    } else if (knownEaKeys.has(key)) {
      const target = EA_TO_NORMALIZED[key]!;
      // OR-merge: several EA keys can map to one normalized key (e.g.
      // panicCloseAll + closeAllBySymbol → supportsEmergencyClose). Any true
      // source makes the normalized capability true.
      normalized[target] = normalized[target] || val;
    } else if (val === true) {
      // Unknown TRUE key: preserve it for diagnostics, but it must NOT enable
      // any feature. Record it as unmapped.
      unmapped.push(key);
    }
  }

  // Legacy closed-set caps (v1.40) still parsed so existing UI keeps working.
  const legacy = normaliseCapabilities(raw);

  const str = (v: unknown, max = 32): string | null =>
    typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

  return {
    rawEaCapabilities: rawObj,
    normalizedCapabilities: normalized,
    legacyCapabilities: legacy,
    unmappedKeys: unmapped,
    eaName: str(eaMeta?.eaName) ?? str(rawObj["eaName"]),
    eaVersion: str(eaMeta?.eaVersion) ?? str(rawObj["eaVersion"]),
    eaBuild: str(eaMeta?.build) ?? str(rawObj["build"]),
    eaProtocol: str(eaMeta?.protocol) ?? str(rawObj["protocol"]),
    lastCapabilitySeenAt: new Date().toISOString(),
  };
}

/** Is the connected EA v1.50-capability-aware? (reports the new vocabulary) */
export function isV150Aware(ingest: CapabilityIngest): boolean {
  // v1.50-aware if it reported a protocol >= 2 OR any normalized cap that the
  // legacy v1.40 set could not have produced (e.g. validate-only / discovery).
  const proto = parseInt(ingest.eaProtocol ?? "0", 10);
  if (proto >= 2) return true;
  return ingest.normalizedCapabilities.supportsValidateOnly
      || ingest.normalizedCapabilities.supportsSymbolDiscovery
      || ingest.normalizedCapabilities.supportsAccountSnapshots;
}

/** Required-version gate. Returns a user-facing update message, or null. */
export function eaUpdateRequiredMessage(
  runningVersion: string | null,
  requiredVersion = "1.50",
): string | null {
  const parse = (v: string | null) => {
    if (!v) return 0;
    const m = v.match(/(\d+)\.(\d+)/);
    return m ? parseInt(m[1]!, 10) * 100 + parseInt(m[2]!, 10) : 0;
  };
  if (parse(runningVersion) < parse(requiredVersion)) {
    return `EA update required — running ${runningVersion ?? "unknown"}, required v${requiredVersion}+.`;
  }
  return null;
}
