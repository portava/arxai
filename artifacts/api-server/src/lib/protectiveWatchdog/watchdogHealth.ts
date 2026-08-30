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
//
// THE SECOND RULE: this endpoint has NO authentication. It therefore has two
// detail levels. On a loopback bind (`full`) it prints the scoped finding keys
// — `unprotected_position:9002` — because the only reader is someone already
// on the box. On any other bind (`redacted`) it prints counts only, and drops
// the instance id (which defaults to `hostname:pid`) and the topology, because
// an anonymous caller must not be able to learn WHICH positions are
// unprotected or WHERE this watchdog runs. Status, http code and reason are
// identical in both modes, so an uptime monitor sees exactly the same signal.

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

/**
 * How much this UNAUTHENTICATED body may disclose.
 *   full     — loopback bind: scoped finding keys, instance id, topology.
 *   redacted — any other bind: counts only, no identifiers.
 */
export type WatchdogHealthDetail = "full" | "redacted";

/** A non-loopback bind is reachable by someone who is not already on the box,
 *  so it gets the redacted body. This is the only input to that decision. */
export function healthDetailForHost(host: string): WatchdogHealthDetail {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" ? "full" : "redacted";
}

export const REDACTED = "[redacted — unauthenticated surface]";

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
    /** Empty in `redacted` mode — `activeFindingCount` still carries the signal. */
    activeFindingKeys: string[];
    activeFindingCount: number;
    passCount: number;
    consecutiveCannotVerify: number;
    alertPath: { lastDelivery: string | null; degraded: boolean };
    /** Which disclosure level produced this body, stated rather than implied. */
    detail: WatchdogHealthDetail;
    /** What this endpoint can and cannot vouch for — no platform-wide claims. */
    surface: { process: "independent-protection-watchdog"; readOnlyDatabaseSession: true; placesOrders: false };
  };
}

function stalenessLimitMs(intervalMs: number): number {
  return Math.max(HEALTH_STALE_PASS_FLOOR_MS, intervalMs * HEALTH_STALE_PASS_MULTIPLIER);
}

export function renderWatchdogHealth(
  state: WatchdogLivenessState,
  nowMs: number,
  detail: WatchdogHealthDetail = "full",
): WatchdogHealthRender {
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
    // The underlying reason is a driver message and can name the host or the
    // database, so it is withheld on the unauthenticated (non-loopback) body.
    // The STATUS is unchanged — a monitor still sees "not a green light".
    const why = detail === "full" ? (state.lastCannotVerifyReason ?? "unspecified") : "withheld on this surface — see the watchdog's own logs";
    reason = `the last pass could NOT read protection state (${why}) — this is not a green light`;
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
      // `hostname:pid` by default — an identifier for WHERE the watcher runs.
      instanceId: detail === "full" ? state.instanceId : REDACTED,
      topology: detail === "full" ? state.topology : REDACTED,
      watchdogUptimeSeconds: uptimeSeconds,
      lastPassAgeSeconds,
      lastVerdict: state.lastVerdict,
      // Scoped keys name individual positions/commands (`unprotected_position:9002`).
      activeFindingKeys: detail === "full" ? state.activeFindingKeys.slice(0, 50) : [],
      activeFindingCount: state.activeFindingKeys.length,
      passCount: state.passCount,
      consecutiveCannotVerify: state.consecutiveCannotVerify,
      alertPath: {
        // A delivery summary can name the configured legs; the degraded flag
        // is the part a monitor needs and carries no identifiers.
        lastDelivery: detail === "full" ? state.lastDeliverySummary : null,
        degraded: state.lastDeliveryDegraded,
      },
      detail,
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
  detail: WatchdogHealthDetail = "full",
): { httpStatus: number; body: unknown } {
  if (pathname === "/healthz" || pathname === "/") {
    const r = renderWatchdogHealth(state, nowMs, detail);
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
