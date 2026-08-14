// T033 Phase 10 — client capability gating.
//
// Reads the v1.50 normalized capabilities the backend now returns on
// /me/live/bridge-debug (sourced from the heartbeat the EA sends) and exposes a
// small `can(action)` gate the trade surfaces use to hide/disable unsupported
// actions.
//
// SAFETY / DEFAULT-DENY for UI: a capability that is false, missing, or unknown
// resolves to `false` → the action is hidden/disabled. We never *enable* an
// action from a missing capability. This only affects what buttons SHOW; the
// server gate chain remains the real authority on whether anything executes.
//
// When the connected EA is pre-v1.50 (capabilities === null), `can()` returns
// false for everything v1.50-specific, and `needsEaUpdate` is true so the UI
// can show a compact "EA update required" hint instead of dead buttons.

import { useQuery } from "@tanstack/react-query";

const BASE = (() => {
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    return (env?.BASE_URL || "/").replace(/\/$/, "");
  } catch {
    return "";
  }
})();

// The normalized capability keys (must match V150_NORMALIZED_KEYS on the backend).
export type CapabilityKey =
  | "supportsMarketOrders"
  | "supportsPendingOrders"
  | "supportsModifySLTP"
  | "supportsModifyPendingOrders"
  | "supportsCancelPendingOrders"
  | "supportsClosePosition"
  | "supportsPartialClose"
  | "supportsReverse"
  | "supportsBreakEven"
  | "supportsTrailingStop"
  | "supportsSymbolDiscovery"
  | "supportsBrokerRules"
  | "supportsValidateOnly"
  | "supportsAccountSnapshots"
  | "supportsOpenPositionSync"
  | "supportsPendingOrderSync"
  | "supportsManualMT5Detection"
  | "supportsStructuredErrors"
  | "supportsEmergencyClose"
  | "supportsRemoteConfig"
  | "supportsCommandIdempotency"
  | "supportsMagicCommentTagging"
  | "supportsTelemetry";

interface BridgeDebugResponse {
  bridge: {
    eaVersion?: string | null;
    capabilities?: Record<string, boolean> | null;
    capabilityMeta?: {
      eaVersion: string | null;
      eaProtocol: string | null;
      unmapped: string[];
      lastSeenAt: string | null;
      v150Aware: boolean;
    };
  } | null;
}

export interface LiveCapabilities {
  /** Raw normalized cap map, or null if the EA is pre-v1.50 / not reporting. */
  caps: Record<string, boolean> | null;
  /** True when an EA is attached but not v1.50-capability-aware. */
  needsEaUpdate: boolean;
  /** The running EA version, if known. */
  eaVersion: string | null;
  /** Loading state passthrough. */
  isLoading: boolean;
  /**
   * Default-deny gate: returns true ONLY if the named capability is explicitly
   * true. false / missing / unknown / pre-v1.50 → false (hide the action).
   */
  can: (key: CapabilityKey) => boolean;
}

const REQUIRED_VERSION = "1.50";

export function useLiveCapabilities(): LiveCapabilities {
  const q = useQuery<BridgeDebugResponse>({
    queryKey: ["live-bridge-capabilities"],
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const r = await fetch(`${BASE}/api/me/live/bridge-debug`, {
          credentials: "include",
          signal: ctrl.signal,
        });
        if (!r.ok) return { bridge: null };
        return (await r.json()) as BridgeDebugResponse;
      } catch {
        return { bridge: null };
      } finally {
        clearTimeout(t);
      }
    },
  });

  const bridge = q.data?.bridge ?? null;
  const caps = bridge?.capabilities ?? null;
  const eaVersion = bridge?.capabilityMeta?.eaVersion ?? bridge?.eaVersion ?? null;

  // needsEaUpdate: an EA is attached (bridge exists, has a version) but it is
  // not v1.50-aware (no normalized caps reported). Distinct from "no bridge at
  // all" (bridge === null), where we don't nag about an update.
  const v150Aware = bridge?.capabilityMeta?.v150Aware ?? (caps !== null);
  const needsEaUpdate = bridge !== null && !!eaVersion && !v150Aware;

  const can = (key: CapabilityKey): boolean => {
    // Default-deny: only an explicit true enables the action.
    return caps != null && caps[key] === true;
  };

  return {
    caps,
    needsEaUpdate,
    eaVersion,
    isLoading: q.isLoading,
    can,
  };
}

export { REQUIRED_VERSION as REQUIRED_EA_VERSION };
