import {
  AUTH_ERROR_CODES,
  BROKER_HEALTH_SEVERITY,
  type BrokerHealthInput,
  type BrokerHealthStatus,
  type BrokerHealthVerdict,
} from "./types.js";

// Severity-ordered status resolution. The first matching predicate wins,
// because operators must see the most-severe blocker first.

const HEARTBEAT_DEGRADED_MS = 30_000;          //  >30s = degraded
const HEARTBEAT_DISCONNECTED_MS = 60_000;      //  >60s = disconnected
const PRICE_FEED_WARN_MS = 60_000;             //  >60s = price feed delayed (WARN)
const PRICE_FEED_DANGER_MS = 180_000;          // >180s = treated as disconnected feed

/** Pure: evaluate broker health given a normalized input snapshot. No I/O. */
export function evaluateBrokerHealth(input: BrokerHealthInput): BrokerHealthVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  const heartbeatAgeMs = input.lastHeartbeatAtMs == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.nowMs - input.lastHeartbeatAtMs);
  const latencyMs = Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null;

  // 1. MAINTENANCE_MODE — explicit operator toggle, highest priority.
  if (input.maintenanceMode) {
    return finish("MAINTENANCE_MODE",
      ["maintenance mode is active"],
      [],
      ["broker is in maintenance mode — live execution paused"],
      latencyMs,
    );
  }

  // 2. AUTH_ERROR — credentials/login problem. Reconnect alone won't fix this.
  if (input.lastErrorCode && AUTH_ERROR_CODES.has(input.lastErrorCode)) {
    return finish("AUTH_ERROR",
      [`broker reported ${input.lastErrorCode}`],
      [],
      ["broker authentication failed — re-link account before live execution"],
      latencyMs,
    );
  }

  // 3. DISCONNECTED — no heartbeat or stale beyond DISCONNECTED threshold.
  if (heartbeatAgeMs >= HEARTBEAT_DISCONNECTED_MS) {
    return finish("DISCONNECTED",
      input.lastHeartbeatAtMs == null
        ? ["no MT5 heartbeat ever received"]
        : [`MT5 heartbeat is ${Math.round(heartbeatAgeMs / 1000)}s stale`],
      [],
      ["broker / MT5 is not connected — live execution unavailable"],
      latencyMs,
    );
  }

  // 4. EXECUTION_DISABLED — operator toggle off (heartbeat may be fine).
  if (!input.executionEnabled) {
    return finish("EXECUTION_DISABLED",
      ["operator disabled live execution"],
      [],
      ["live execution is disabled by operator — re-enable to send orders"],
      latencyMs,
    );
  }

  // 5. PRICE_FEED_DELAYED — explicit lag signal or stale lastSyncAt.
  const syncAgeMs = input.lastSyncAtMs == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.nowMs - input.lastSyncAtMs);
  const priceLagMs = input.priceFeedDelayMs ?? syncAgeMs;
  if (Number.isFinite(priceLagMs) && priceLagMs >= PRICE_FEED_DANGER_MS) {
    return finish("PRICE_FEED_DELAYED",
      [`price feed lag ${Math.round(priceLagMs / 1000)}s exceeds danger threshold`],
      [],
      ["price feed is severely delayed — live execution would route on stale prices"],
      latencyMs,
    );
  }
  if (Number.isFinite(priceLagMs) && priceLagMs >= PRICE_FEED_WARN_MS) {
    return finish("PRICE_FEED_DELAYED",
      [`price feed lag ${Math.round(priceLagMs / 1000)}s above safe threshold`],
      [`price feed lag ${Math.round(priceLagMs / 1000)}s — confirm fills carefully`],
      ["price feed is delayed beyond safe live-execution threshold"],
      latencyMs,
    );
  }

  // 6. DEGRADED — heartbeat alive but slow.
  if (heartbeatAgeMs >= HEARTBEAT_DEGRADED_MS) {
    return finish("DEGRADED",
      [`MT5 heartbeat is ${Math.round(heartbeatAgeMs / 1000)}s old`],
      ["heartbeat is degraded — link is alive but slow"],
      [],
      latencyMs,
    );
  }
  if (input.reconnectAttempts > 0) {
    warnings.push(`recent reconnect attempts: ${input.reconnectAttempts}`);
  }

  // 7. CONNECTED — clean. Optional warnings still surface.
  reasons.push("MT5 heartbeat fresh, execution enabled, no auth or feed issues");
  return finish("CONNECTED", reasons, warnings, blockers, latencyMs);
}

function finish(
  status: BrokerHealthStatus,
  reasons: string[],
  warnings: string[],
  blockers: string[],
  latencyMs: number | null,
): BrokerHealthVerdict {
  return {
    status,
    severity: BROKER_HEALTH_SEVERITY[status],
    reasons,
    warnings,
    blockers,
    latencyMs,
    aiExplanation: aiExplain(status, reasons),
  };
}

function aiExplain(status: BrokerHealthStatus, reasons: string[]): string {
  switch (status) {
    case "CONNECTED":
      return "Broker link is healthy. Heartbeat is fresh and execution is enabled.";
    case "DEGRADED":
      return "Broker heartbeat is slow. The link is alive but you should monitor before sending live orders.";
    case "PRICE_FEED_DELAYED":
      return "Price feed is delayed. Avoid live execution until the feed stabilizes.";
    case "DISCONNECTED":
      return "Live trading is disabled because MT5 is disconnected. Reconnect before placing trades.";
    case "AUTH_ERROR":
      return "Broker authentication failed. Re-link your MT5 credentials before live execution.";
    case "EXECUTION_DISABLED":
      return "Live execution is currently disabled by the operator. Re-enable it from the Broker Health panel.";
    case "MAINTENANCE_MODE":
      return "Broker is in maintenance mode. Live execution is paused — wait for maintenance to clear.";
    default:
      return reasons.join("; ");
  }
}
