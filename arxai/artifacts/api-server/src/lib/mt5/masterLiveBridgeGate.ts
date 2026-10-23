// Master Bridge LIVE — Bridge-Binding Gate
//
// Runs BEFORE the existing Phase B 16-gate evaluator inside
// `dispatchLiveCommand` whenever `accountRoutingMode = SHARED_MASTER_MT5`.
// Refuses dispatch when:
//   - the platform_master_bridge_connection_id column is unset
//   - the currently-detected bridge id does not match the stored snapshot
//     (BRIDGE_BINDING_MISMATCH)
//   - the detector itself refuses (MASTER_LIVE_REQUIRES_REAL_BRIDGE /
//     MASTER_BRIDGE_HEARTBEAT_STALE / MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED)
//   - the operator flag `master_bridge_live_enabled` is false
//   - `shared_live_trading_enabled` is false
//
// Returns a tagged decision object the pipeline can flat-map into the
// existing `LIVE_BLOCKED` rejection path WITHOUT calling the actual
// broker dispatch. NEVER returns OK unless every gate above passes.
//
// This gate adds these block reasons on top of the existing Phase B set:
//   MASTER_LIVE_REQUIRES_REAL_BRIDGE
//   MASTER_BRIDGE_HEARTBEAT_STALE
//   MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED
//   MASTER_BRIDGE_EA_VERSION_TOO_OLD
//   MASTER_BRIDGE_NOT_LIVE_CAPABLE
//   MASTER_BRIDGE_NOT_CONFIGURED   (platform_master_bridge_connection_id null)
//   MASTER_BRIDGE_LIVE_NOT_ENABLED (master_bridge_live_enabled=false)
//   BRIDGE_BINDING_MISMATCH        (detected id ≠ stored id)
//   SHARED_LIVE_TRADING_DISABLED   (shared_live_trading_enabled=false)
//   PER_USER_BRIDGE_MODE_ACTIVE    (routing mode != SHARED_MASTER_MT5;
//                                   caller used the wrong gate)
import { db, globalTradingSettingsTable } from "@workspace/db";
import {
  detectCurrentConnectedBridge,
  type DetectedBridgeEvidence,
} from "./currentConnectedBridgeDetector.js";

export type MasterLiveGateBlockReason =
  | "MASTER_LIVE_REQUIRES_REAL_BRIDGE"
  | "MASTER_BRIDGE_HEARTBEAT_STALE"
  | "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED"
  | "MASTER_BRIDGE_EA_VERSION_TOO_OLD"
  | "MASTER_BRIDGE_NOT_LIVE_CAPABLE"
  | "MASTER_BRIDGE_NOT_CONFIGURED"
  | "MASTER_BRIDGE_LIVE_NOT_ENABLED"
  | "BRIDGE_BINDING_MISMATCH"
  | "SHARED_LIVE_TRADING_DISABLED"
  | "PER_USER_BRIDGE_MODE_ACTIVE"
  | "NO_BRIDGE_REGISTERED";

export interface MasterLiveGateInput {
  // Routing mode read from global_trading_settings.accountRoutingMode.
  accountRoutingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  // shared_live_trading_enabled
  sharedLiveTradingEnabled: boolean;
  // master_bridge_live_enabled
  masterBridgeLiveEnabled: boolean;
  // The persisted platform_master_bridge_connection_id snapshot.
  platformMasterBridgeConnectionId: number | null;
  // The detector's verdict at this exact moment.
  detector:
    | { ok: true; bridge: DetectedBridgeEvidence }
    | { ok: false; primaryReason: MasterLiveGateBlockReason };
}

export type MasterLiveGateResult =
  | {
      decision: "PASS";
      // The bridge id every downstream Phase B step MUST use. The pipeline
      // overrides its bridge selection with this id when PASS, ensuring
      // pickupNextLiveCommand binds to and recordLiveCommandResult
      // validates against the exact same row.
      boundBridgeId: number;
      bridge: DetectedBridgeEvidence;
    }
  | {
      decision: "BLOCKED";
      primaryReason: MasterLiveGateBlockReason;
      blockReasons: MasterLiveGateBlockReason[];
    };

/** Pure evaluator — given inputs, decides PASS/BLOCKED. No I/O. */
export function evaluateMasterLiveBridgeGate(
  input: MasterLiveGateInput,
): MasterLiveGateResult {
  const reasons: MasterLiveGateBlockReason[] = [];

  if (input.accountRoutingMode !== "SHARED_MASTER_MT5") {
    reasons.push("PER_USER_BRIDGE_MODE_ACTIVE");
  }
  if (!input.sharedLiveTradingEnabled) {
    reasons.push("SHARED_LIVE_TRADING_DISABLED");
  }
  if (!input.masterBridgeLiveEnabled) {
    reasons.push("MASTER_BRIDGE_LIVE_NOT_ENABLED");
  }
  if (input.platformMasterBridgeConnectionId == null) {
    reasons.push("MASTER_BRIDGE_NOT_CONFIGURED");
  }
  if (!input.detector.ok) {
    reasons.push(input.detector.primaryReason);
  } else if (
    input.platformMasterBridgeConnectionId != null &&
    input.detector.bridge.bridgeId !== input.platformMasterBridgeConnectionId
  ) {
    // The detected current connected bridge differs from the persisted
    // snapshot — the operator must re-snapshot before dispatch. This is
    // the heart of the "selected bridge must equal current connected
    // bridge" rule.
    reasons.push("BRIDGE_BINDING_MISMATCH");
  }

  if (reasons.length > 0) {
    return {
      decision: "BLOCKED",
      primaryReason: reasons[0]!,
      blockReasons: reasons,
    };
  }
  // Invariant: detector.ok=true (we would have pushed otherwise) AND
  // platformMasterBridgeConnectionId is non-null and matches.
  const det = input.detector as { ok: true; bridge: DetectedBridgeEvidence };
  return {
    decision: "PASS",
    boundBridgeId: det.bridge.bridgeId,
    bridge: det.bridge,
  };
}

/**
 * Convenience wrapper that loads global_trading_settings, runs the
 * detector, and evaluates. Used by `dispatchLiveCommand` and by the
 * route layer to render "is master live ready" UI without duplicating
 * the wiring. Never throws on missing settings row — treats absence
 * as fail-closed (returns MASTER_BRIDGE_LIVE_NOT_ENABLED).
 */
export async function loadAndEvaluateMasterLiveBridgeGate(): Promise<MasterLiveGateResult> {
  const settings = await db.select().from(globalTradingSettingsTable).limit(1);
  const s = settings[0];
  if (!s) {
    return {
      decision: "BLOCKED",
      primaryReason: "MASTER_BRIDGE_LIVE_NOT_ENABLED",
      blockReasons: ["MASTER_BRIDGE_LIVE_NOT_ENABLED"],
    };
  }
  const detector = await detectCurrentConnectedBridge();
  return evaluateMasterLiveBridgeGate({
    accountRoutingMode: (s.accountRoutingMode as "USER_OWNED_MT5" | "SHARED_MASTER_MT5") ?? "USER_OWNED_MT5",
    sharedLiveTradingEnabled: !!s.sharedLiveTradingEnabled,
    masterBridgeLiveEnabled: !!s.masterBridgeLiveEnabled,
    platformMasterBridgeConnectionId: s.platformMasterBridgeConnectionId ?? null,
    detector: detector.ok
      ? { ok: true, bridge: detector.bridge }
      : { ok: false, primaryReason: detector.primaryReason as MasterLiveGateBlockReason },
  });
}
