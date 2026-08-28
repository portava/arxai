// Phase 6 — kill-switch RELEASE policy.
//
// The global emergency kill switch is born ENGAGED (schema default, and the
// guided dispatch path additionally treats a MISSING settings row as engaged).
// Before this module, the only sanctioned release lived inside
// POST /admin/live-shared/activate-step, whose footgun guard requires full
// MT5 shared-live posture — routing SHARED_MASTER_MT5, both shared flags on,
// a master bridge pinned. That guard is correct for a HOT release, and it
// made the Tier 1 guided demo certification structurally unreachable: no one
// should have to stand up live MT5 posture to send one $1 demo order.
//
// The resolution is NOT to weaken any dispatch-side check. The guided path
// still refuses while any of its three stop controls is engaged. Instead,
// release itself gets a second, narrower doorway: an admin may release the
// switch ONLY while the platform is provably COLD — every control that could
// route a real-money order is off. A release under that posture cannot enable
// live execution by itself, because each live surface still has its own
// independent denials (liveEnabled, platformMode, the DB arm flag, the
// server-side env switch, and the 16-gate evaluator). A release while ANY of
// those is hot must still go through the full activate-step ceremony.
//
// This module is pure so the policy is testable and mutation-provable without
// a database.

/** Everything the release decision consults. Caller resolves each field. */
export type KillSwitchReleasePosture = {
  platformMode: string;
  liveEnabled: boolean;
  sharedLiveTradingEnabled: boolean;
  masterBridgeLiveEnabled: boolean;
  liveBrokerExecutionArmed: boolean;
  /** The server-side env switch, resolved via phaseBConfig — never read here. */
  liveBrokerExecutionEnvEnabled: boolean;
};

type SettingsRowSubset = {
  platformMode?: string | null;
  liveEnabled?: boolean | null;
  sharedLiveTradingEnabled?: boolean | null;
  masterBridgeLiveEnabled?: boolean | null;
  liveBrokerExecutionArmed?: boolean | null;
} | null | undefined;

/**
 * Derive the posture from a settings row. A MISSING row maps to the schema
 * defaults (platform OFF, everything false) — cold, but the caller must still
 * CREATE the row engaged and release it as an explicit transition, never
 * birth it released.
 *
 * Unknown/null field values resolve to the HOT reading, not the cold one:
 * a posture we cannot prove cold is not cold.
 */
export function postureFromSettingsRow(
  row: SettingsRowSubset,
  envEnabled: boolean,
): KillSwitchReleasePosture {
  if (!row) {
    return {
      platformMode: "OFF",
      liveEnabled: false,
      sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false,
      liveBrokerExecutionArmed: false,
      liveBrokerExecutionEnvEnabled: envEnabled,
    };
  }
  return {
    platformMode: row.platformMode ?? "LIVE",
    liveEnabled: row.liveEnabled !== false,
    sharedLiveTradingEnabled: row.sharedLiveTradingEnabled !== false,
    masterBridgeLiveEnabled: row.masterBridgeLiveEnabled !== false,
    liveBrokerExecutionArmed: row.liveBrokerExecutionArmed !== false,
    liveBrokerExecutionEnvEnabled: envEnabled,
  };
}

/**
 * The cold-posture wall. Empty array = release permitted. Every hot control
 * is reported, not just the first, so the operator sees the full distance to
 * cold rather than discovering it one refusal at a time.
 */
export function killSwitchReleaseViolations(p: KillSwitchReleasePosture): string[] {
  const violations: string[] = [];
  if (p.platformMode === "LIVE") {
    violations.push("platformMode is LIVE");
  }
  if (p.liveEnabled) {
    violations.push("liveEnabled is true");
  }
  if (p.sharedLiveTradingEnabled) {
    violations.push("sharedLiveTradingEnabled is true");
  }
  if (p.masterBridgeLiveEnabled) {
    violations.push("masterBridgeLiveEnabled is true");
  }
  if (p.liveBrokerExecutionArmed) {
    violations.push("liveBrokerExecutionArmed is true");
  }
  if (p.liveBrokerExecutionEnvEnabled) {
    violations.push("ARX_LIVE_BROKER_EXECUTION_ENABLED is enabled server-side");
  }
  return violations;
}
