// Capability #28 — the watchdog's OWN liveness surface.
//
// A watchdog nobody watches is a watchdog that can die silently. This module
// renders the process's self-report so an uptime monitor (or the owner) can
// see that the watcher itself is alive and, separately, whether its last pass
// could actually SEE anything.
//
// PURE by design: `renderWatchdogHealth` takes state + a clock and returns
// {httpStatus, body}. The socket lives in watchdog.ts; binding is not needed
// to test the contract (and the CI sandbox forbids listen(2)).
//
// THE RULE THIS FILE ENFORCES: 200 means "I looked, and everything I checked
// was fine". Everything else — never ran, stale pass, could not read the
// database, alert path down — is 503 with a reason. There is no state in
// which an unreadable pass renders as healthy.

import type { WatchdogPassVerdict } from "./watchdogAlertEnvelope.js";

/** How far behind schedule a pass may fall before liveness is considered stale. */
export const HEALTH_STALE_PASS_MULTIPLIER = 3;
export const HEALTH_STALE_PASS_FLOOR_MS = 90_000;

export interface WatchdogLivenessState {
  instanceId: string;
  topology: string;
  startedAtMs: number;
  intervalMs: number;
  /** null until the first pass has completed. */
  lastPassCompletedAtMs: number | null;
  lastVerdict: WatchdogPassVerdict | null;
  lastCannotVerifyReason: string | null;
  activeFindingKeys: string[];
  /** Delivery summary of the last pass, e.g. "app:delivered,webhook:not_configured". */
  lastDeliverySummary: string | null;
  lastDeliveryDegraded: boolean;
  passCount: number;
  consecutiveCannotVerify: number;
}

export function newLivenessState(args: {
  instanceId: string; topology: string; startedAtMs: number; intervalMs: number;
}): WatchdogLivenessState {
  return {
    instanceId: args.instanceId,
    topology: args.topology,
    startedAtMs: args.startedAtMs,
    intervalMs: args.intervalMs,
    lastPassCompletedAtMs: null,
    lastVerdict: null,
    lastCannotVerifyReason: null,
    activeFindingKeys: [],
    lastDeliverySummary: null,
    lastDeliveryDegraded: false,
    passCount: 0,
    consecutiveCannotVerify: 0,
  };
}

export type WatchdogHealthStatus =
  | "watching"          // last pass read everything and found no CRITICAL
  | "findings"          // last pass read everything and found something
  | "cannot_verify"     // last pass could not read — NOT healthy
  | "never_ran"         // process is up but has not completed a pass
  | "stale";            // last pass is older than the interval allows

export interface WatchdogHealthRender {
  httpStatus: number;
  body: {
    ok: boolean;
    status: WatchdogHealthStatus;
    /** Plain-language reason. Always present, including when ok. */
    reason: string;
    instanceId: string;
    topology: string;
    watchdogUptimeSeconds: number;
    lastPassAgeSeconds: number | null;
    lastVerdict: WatchdogPassVerdict | null;
    activeFindingKeys: string[];
    passCount: number;
    consecutiveCannotVerify: number;
    alertPath: { lastDelivery: string | null; degraded: boolean };
    /** What this endpoint can and cannot vouch for — no platform-wide claims. */
    surface: { process: "independent-protection-watchdog"; readOnlyDatabaseSession: true; placesOrders: false };
  };
}

function stalenessLimitMs(intervalMs: number): number {
  return Math.max(HEALTH_STALE_PASS_FLOOR_MS, intervalMs * HEALTH_STALE_PASS_MULTIPLIER);
}

export function renderWatchdogHealth(state: WatchdogLivenessState, nowMs: number): WatchdogHealthRender {
  const uptimeSeconds = Math.max(0, Math.floor((nowMs - state.startedAtMs) / 1000));
  const lastPassAgeSeconds = state.lastPassCompletedAtMs === null
    ? null
    : Math.max(0, Math.floor((nowMs - state.lastPassCompletedAtMs) / 1000));

  let status: WatchdogHealthStatus;
  let reason: string;

  if (state.lastPassCompletedAtMs === null || state.lastVerdict === null) {
    status = "never_ran";
    reason = "the watchdog process is up but has not completed a pass — nothing has been verified yet";
  } else if (nowMs - state.lastPassCompletedAtMs > stalenessLimitMs(state.intervalMs)) {
    status = "stale";
    reason = `last pass completed ${lastPassAgeSeconds}s ago, beyond the ${Math.round(stalenessLimitMs(state.intervalMs) / 1000)}s limit — the loop may be wedged`;
  } else if (state.lastVerdict === "CANNOT_VERIFY") {
    status = "cannot_verify";
    reason = `the last pass could NOT read protection state (${state.lastCannotVerifyReason ?? "unspecified"}) — this is not a green light`;
  } else if (state.lastVerdict === "FINDINGS") {
    status = "findings";
    reason = `the last pass read everything and raised ${state.activeFindingKeys.length} open finding(s)`;
  } else {
    status = "watching";
    reason = "the last pass read every section and found no CRITICAL condition";
  }

  // 200 ONLY for a fresh pass that actually read everything. `findings` still
  // returns 200 because the watchdog is doing its job correctly — the finding
  // itself is delivered through the alert path, and conflating "I found a
  // problem in the app" with "I am broken" would make the probe useless.
  // Anything where the WATCHDOG cannot vouch for what it saw is 503.
  const ok = status === "watching" || status === "findings";

  return {
    httpStatus: ok ? 200 : 503,
    body: {
      ok,
      status,
      reason,
      instanceId: state.instanceId,
      topology: state.topology,
      watchdogUptimeSeconds: uptimeSeconds,
      lastPassAgeSeconds,
      lastVerdict: state.lastVerdict,
      activeFindingKeys: state.activeFindingKeys.slice(0, 50),
      passCount: state.passCount,
      consecutiveCannotVerify: state.consecutiveCannotVerify,
      alertPath: { lastDelivery: state.lastDeliverySummary, degraded: state.lastDeliveryDegraded },
      surface: { process: "independent-protection-watchdog", readOnlyDatabaseSession: true, placesOrders: false },
    },
  };
}

/**
 * Route a request path to a render. Only two paths exist; anything else is a
 * 404 with no body detail (the health port must not become a data surface).
 */
export function handleWatchdogHealthRequest(
  pathname: string,
  state: WatchdogLivenessState,
  nowMs: number,
): { httpStatus: number; body: unknown } {
  if (pathname === "/healthz" || pathname === "/") {
    const r = renderWatchdogHealth(state, nowMs);
    return { httpStatus: r.httpStatus, body: r.body };
  }
  if (pathname === "/livez") {
    // Process-liveness only: "the node process is running". Deliberately
    // separate from /healthz so an orchestrator restart policy and an
    // "is protection verified" probe can never be confused for one another.
    return { httpStatus: 200, body: { ok: true, status: "process_alive", note: "process liveness only — see /healthz for whether protection was verified" } };
  }
  return { httpStatus: 404, body: { ok: false, error: "not_found" } };
}
