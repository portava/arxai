import type { Mt5ConnectionState, Mt5Status } from "./mt5.types";
import {
  MT5_HEARTBEAT_FRESH_BELOW_SECONDS,
  MT5_HEARTBEAT_OFFLINE_AT_SECONDS,
  classifyHeartbeatAgeMs,
} from "../broker-health/heartbeatPolicy.js";

export interface BrokerHealthReport {
  status: Mt5Status;
  isHealthy: boolean;
  isStale: boolean;
  ageSeconds: number | null;
  reasons: string[];
}

// Default thresholds are the shared MT5 heartbeat policy (owner decision 17):
// DELAYED from 15 s (degraded), ERROR from 60 s (offline). The bounds are
// exclusive-fresh like the policy: age >= bound crosses it. A caller may still
// override per environment; no app caller does.
export const DEFAULTS = {
  staleAfterSeconds: MT5_HEARTBEAT_FRESH_BELOW_SECONDS,
  errorAfterSeconds: MT5_HEARTBEAT_OFFLINE_AT_SECONDS,
};

export function evaluateBrokerHealth(
  state: Mt5ConnectionState,
  now: Date = new Date(),
  thresholds: Partial<typeof DEFAULTS> = {},
): BrokerHealthReport {
  const cfg = { ...DEFAULTS, ...thresholds };
  const reasons: string[] = [];

  if (state.status === "ERROR") {
    reasons.push("Broker reports ERROR state");
    return { status: "ERROR", isHealthy: false, isStale: true, ageSeconds: null, reasons };
  }
  if (state.lastHeartbeatMs == null) {
    reasons.push("No heartbeat received yet");
    return { status: "DISCONNECTED", isHealthy: false, isStale: true, ageSeconds: null, reasons };
  }

  const age = (now.getTime() - state.lastHeartbeatMs) / 1000;
  if (classifyHeartbeatAgeMs(age * 1000) === "unknown") {
    reasons.push("Heartbeat time is invalid (non-finite or in the future)");
    return { status: "DISCONNECTED", isHealthy: false, isStale: true, ageSeconds: null, reasons };
  }
  const isStale = age >= cfg.staleAfterSeconds;
  let status: Mt5Status = state.status;
  if (age >= cfg.errorAfterSeconds) {
    status = "ERROR";
    reasons.push(`Heartbeat ${Math.round(age)}s old — exceeded error threshold ${cfg.errorAfterSeconds}s`);
  } else if (isStale) {
    status = "DELAYED";
    reasons.push(`Heartbeat ${Math.round(age)}s old — exceeded stale threshold ${cfg.staleAfterSeconds}s`);
  }

  const isHealthy = status === "CONNECTED" && !isStale;
  return { status, isHealthy, isStale, ageSeconds: age, reasons };
}

export function isLiveTradingPermitted(state: Mt5ConnectionState): boolean {
  return state.mode === "LIVE" && state.status === "CONNECTED";
}
