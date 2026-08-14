import type { Mt5ConnectionState, Mt5Status } from "./mt5.types";

export interface BrokerHealthReport {
  status: Mt5Status;
  isHealthy: boolean;
  isStale: boolean;
  ageSeconds: number | null;
  reasons: string[];
}

// Default thresholds — caller can override per environment.
export const DEFAULTS = {
  staleAfterSeconds: 30,
  errorAfterSeconds: 120,
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
  const isStale = age > cfg.staleAfterSeconds;
  let status: Mt5Status = state.status;
  if (age > cfg.errorAfterSeconds) {
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
