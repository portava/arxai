// Platform Bridge Mode — explicit 5-value enum for the routing/execution
// state the platform is currently in. Pure function over existing settings;
// adds no DB column. Browser-safe (no Node imports).
//
// SAFETY: contract-only. Importing/calling this does NOT unlock any
// execution path. It only summarizes what the gates already say.
//
// Mode meanings:
//   demo                                — platform is in demo-only mode
//                                         (no master bridge live; user-owned
//                                         bridges paused). No live possible.
//   per_user_live_bridge                — each user runs their own MT5
//                                         bridge; live dispatch is per-user.
//   master_live_bridge_readonly         — shared master bridge connected,
//                                         but admin keeps it read-only
//                                         (master_bridge_live_enabled=false
//                                         or shared_live_trading_enabled=false).
//   master_live_bridge_execution_pending — master bridge enabled at the
//                                         platform layer, but server master
//                                         switch ARX_LIVE_BROKER_EXECUTION_ENABLED
//                                         is OFF. Phase B still refuses
//                                         every dispatch with
//                                         BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.
//   master_live_bridge_execution_enabled — all platform-level flags are on;
//                                         per-user gates and the 16-gate
//                                         Phase B evaluator still decide
//                                         each individual dispatch.

export type PlatformBridgeMode =
  | "demo"
  | "per_user_live_bridge"
  | "master_live_bridge_readonly"
  | "master_live_bridge_execution_pending"
  | "master_live_bridge_execution_enabled";

export const PLATFORM_BRIDGE_MODES: readonly PlatformBridgeMode[] = [
  "demo",
  "per_user_live_bridge",
  "master_live_bridge_readonly",
  "master_live_bridge_execution_pending",
  "master_live_bridge_execution_enabled",
] as const;

export interface PlatformBridgeModeInput {
  /** global_trading_settings.platformMode: OFF | SIMULATED | DEMO | LIVE */
  platformMode: string | null | undefined;
  /** global_trading_settings.accountRoutingMode: USER_OWNED_MT5 | SHARED_MASTER_MT5 */
  accountRoutingMode: string | null | undefined;
  /** global_trading_settings.masterBridgeLiveEnabled */
  masterBridgeLiveEnabled: boolean;
  /** global_trading_settings.sharedLiveTradingEnabled */
  sharedLiveTradingEnabled: boolean;
  /** Server master switch — process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED === "true" */
  liveBrokerExecutionEnabled: boolean;
}

export interface PlatformBridgeModeResult {
  mode: PlatformBridgeMode;
  /** A short plain-English label for normal users. */
  headline: string;
  /** Whether DEMO trading is available regardless of live state. */
  demoAvailable: boolean;
  /** Whether real-broker dispatch is currently possible at the platform layer. */
  liveBrokerExecutionPossible: boolean;
  /** Short next-step copy for the operator (admin sees), e.g. "Enable master switch." */
  nextPlatformStep: string;
}

/**
 * Pure derivation. No I/O. Order of checks matters: tradingMode=DISABLED
 * or SIMULATED → demo; tradingMode=DEMO → demo. Only LIVE proceeds to
 * routing-mode checks.
 */
export function derivePlatformBridgeMode(
  i: PlatformBridgeModeInput,
): PlatformBridgeModeResult {
  const tm = (i.platformMode ?? "OFF").toUpperCase();
  const arm = (i.accountRoutingMode ?? "USER_OWNED_MT5").toUpperCase();

  // Anything other than LIVE keeps the platform in demo. This includes
  // OFF, SIMULATED, DEMO, and any unrecognised value (fail-closed).
  if (tm !== "LIVE") {
    return {
      mode: "demo",
      headline: "Demo trading only.",
      demoAvailable: true,
      liveBrokerExecutionPossible: false,
      nextPlatformStep:
        "Switch global platform mode to LIVE in admin trading control.",
    };
  }

  // platformMode === "LIVE" at this point
  // Fail-closed: unknown routing mode is treated as demo so we never
  // claim live is possible for an unrecognised configuration.
  if (arm !== "USER_OWNED_MT5" && arm !== "SHARED_MASTER_MT5") {
    return {
      mode: "demo",
      headline: "Demo trading only — routing mode is not recognised.",
      demoAvailable: true,
      liveBrokerExecutionPossible: false,
      nextPlatformStep:
        "Admin must set account_routing_mode to USER_OWNED_MT5 or SHARED_MASTER_MT5.",
    };
  }
  if (arm === "USER_OWNED_MT5") {
    return {
      mode: "per_user_live_bridge",
      headline:
        "Per-user live bridge mode — each user runs their own MT5 bridge.",
      demoAvailable: true,
      // Possible only when a per-user bridge has passed its own 16-gate
      // check at dispatch time. From the platform layer this is "possible
      // in principle". We do NOT mark it false here — the per-user gate
      // decides each attempt.
      liveBrokerExecutionPossible: i.liveBrokerExecutionEnabled,
      nextPlatformStep: i.liveBrokerExecutionEnabled
        ? "Per-user bridges decide each dispatch via the 16-gate evaluator."
        : "Set ARX_LIVE_BROKER_EXECUTION_ENABLED=true on the server to allow per-user live dispatch.",
    };
  }

  // arm === "SHARED_MASTER_MT5"
  if (!i.masterBridgeLiveEnabled || !i.sharedLiveTradingEnabled) {
    return {
      mode: "master_live_bridge_readonly",
      headline: "Master live bridge is connected but read-only.",
      demoAvailable: true,
      liveBrokerExecutionPossible: false,
      nextPlatformStep: !i.masterBridgeLiveEnabled
        ? "Admin must enable master_bridge_live_enabled."
        : "Admin must enable shared_live_trading_enabled.",
    };
  }
  if (!i.liveBrokerExecutionEnabled) {
    return {
      mode: "master_live_bridge_execution_pending",
      headline:
        "Master live bridge ready — waiting for server master switch.",
      demoAvailable: true,
      liveBrokerExecutionPossible: false,
      nextPlatformStep:
        "Set ARX_LIVE_BROKER_EXECUTION_ENABLED=true on the server. Phase B will still re-check all 16 gates per user.",
    };
  }
  return {
    mode: "master_live_bridge_execution_enabled",
    headline: "Master live bridge execution enabled.",
    demoAvailable: true,
    liveBrokerExecutionPossible: true,
    nextPlatformStep:
      "Per-user gates and the 16-gate Phase B evaluator decide each dispatch.",
  };
}
