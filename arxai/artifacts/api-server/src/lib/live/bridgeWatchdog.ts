// Task #31 — Bridge watchdog classifier.
//
// PURE + SIDE-EFFECT-FREE. Given a normalized snapshot of one MT5 bridge
// connection (heartbeat age + EA-reported facts), it classifies the bridge's
// liveness and any operator-actionable conditions. It NEVER touches the DB,
// the kill switch, or any execution gate. It does not enable anything — it
// only surfaces health, exactly mirroring the facts the 16-gate evaluator and
// the live arming gate already read from `mt5_connection.capabilities.eaInputs`.
//
// Liveness thresholds are aligned with the rest of the system:
//   - fresh    : heartbeat ≤ 15s  (matches Phase B gate 7 + deriveStatus)
//   - stale    : 15s < age ≤ 60s  (matches deriveStatus STALE_MS)
//   - offline  : age > 60s or no heartbeat
//   - revoked  : token revoked (terminal — bridge is dead)
//
// The watchdog is advisory. A "fresh" verdict does NOT mean a dispatch will
// pass — the 16-gate evaluator is the only authority for that and is never
// bypassed or weakened here.

export type BridgeLiveness = "fresh" | "stale" | "offline" | "revoked";

export type BridgeCondition =
  | "disconnected"    // EA reports terminalConnected=false
  | "read_only"       // EA input ReadOnlyMode=true
  | "algo_off"        // EA reports algoTradingAllowed=false
  | "live_disabled"   // EA input EnableLiveExecution=false
  | "leader_conflict"; // more than one fresh non-revoked bridge for the same user

export interface BridgeWatchdogInput {
  connectionId: number;
  userId: number | null;
  connectionName: string | null;
  tokenRevokedAt: Date | null;
  lastHeartbeat: Date | null;
  accountType: string | null;
  eaVersion: string | null;
  eaInputs: {
    readOnlyMode?: boolean | null;
    enableLiveExecution?: boolean | null;
    terminalConnected?: boolean | null;
    algoTradingAllowed?: boolean | null;
  };
  /**
   * Count of OTHER non-revoked connections for the SAME user that are
   * currently fresh. When ≥1 (i.e. ≥2 fresh bridges total for one user) the
   * watchdog raises leader_conflict so the operator can resolve a duplicate
   * EA pointing at the same account. Computed by the caller (read-only).
   */
  siblingFreshCount?: number;
  now?: Date;
}

export interface BridgeWatchdogVerdict {
  connectionId: number;
  userId: number | null;
  connectionName: string | null;
  liveness: BridgeLiveness;
  heartbeatAgeSeconds: number | null;
  conditions: BridgeCondition[];
  /** True when liveness is stale/offline — drives the dedupe'd alert. */
  shouldAlert: boolean;
  alertSeverity: "info" | "warning" | "danger";
  summary: string;
}

export const WATCHDOG_FRESH_MAX_SECONDS = 15;
export const WATCHDOG_STALE_MAX_SECONDS = 60;

export function classifyBridge(input: BridgeWatchdogInput): BridgeWatchdogVerdict {
  const now = input.now ?? new Date();
  const base = {
    connectionId: input.connectionId,
    userId: input.userId,
    connectionName: input.connectionName,
  };

  // Revoked is terminal — nothing else matters.
  if (input.tokenRevokedAt != null) {
    return {
      ...base,
      liveness: "revoked",
      heartbeatAgeSeconds: null,
      conditions: [],
      shouldAlert: false,
      alertSeverity: "info",
      summary: "Bridge token revoked — connection is inactive.",
    };
  }

  const ageSeconds = input.lastHeartbeat
    ? Math.max(0, Math.floor((now.getTime() - input.lastHeartbeat.getTime()) / 1000))
    : null;

  let liveness: BridgeLiveness;
  if (ageSeconds == null || ageSeconds > WATCHDOG_STALE_MAX_SECONDS) {
    liveness = "offline";
  } else if (ageSeconds > WATCHDOG_FRESH_MAX_SECONDS) {
    liveness = "stale";
  } else {
    liveness = "fresh";
  }

  // EA-reported conditions only carry meaning when the EA is actually
  // reporting (not offline). An offline bridge's last-known flags are stale,
  // so we suppress condition noise and let the offline state dominate.
  const conditions: BridgeCondition[] = [];
  if (liveness !== "offline") {
    const ea = input.eaInputs;
    if (ea.terminalConnected === false) conditions.push("disconnected");
    if (ea.readOnlyMode === true) conditions.push("read_only");
    if (ea.algoTradingAllowed === false) conditions.push("algo_off");
    if (ea.enableLiveExecution === false) conditions.push("live_disabled");
  }
  if ((input.siblingFreshCount ?? 0) >= 1) conditions.push("leader_conflict");

  const shouldAlert = liveness === "stale" || liveness === "offline";
  const alertSeverity: "info" | "warning" | "danger" =
    liveness === "offline" ? "danger" : liveness === "stale" ? "warning" : "info";

  return {
    ...base,
    liveness,
    heartbeatAgeSeconds: ageSeconds,
    conditions,
    shouldAlert,
    alertSeverity,
    summary: buildSummary(liveness, ageSeconds, conditions),
  };
}

function buildSummary(
  liveness: BridgeLiveness,
  ageSeconds: number | null,
  conditions: BridgeCondition[],
): string {
  const head =
    liveness === "fresh" ? `Bridge healthy (heartbeat ${ageSeconds}s ago).`
      : liveness === "stale" ? `Bridge heartbeat is stale (${ageSeconds}s ago).`
      : liveness === "offline" ? (ageSeconds == null ? "Bridge has never sent a heartbeat." : `Bridge is offline (last heartbeat ${ageSeconds}s ago).`)
      : "Bridge token revoked.";
  if (conditions.length === 0) return head;
  return `${head} Conditions: ${conditions.join(", ")}.`;
}
