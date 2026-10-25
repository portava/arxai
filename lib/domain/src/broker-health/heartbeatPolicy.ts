// Broker Hub — the ONE shared heartbeat policy for MT5 connection heartbeats
// (owner decision 17, 2026-10-25). Pure: no IO, no imports, no clock reads.
//
// Every surface that asks "how fresh is this MT5 connection's heartbeat" — the
// api-server, the pure domain evaluators and the trading dashboard — classifies
// the heartbeat age here. Guard:
// scripts/src/ci/check-single-bridge-freshness-source.ts.
//
// Policy (age = now − last observed heartbeat):
//   age <  15 s            → "fresh"
//   15 s ≤ age < 60 s      → "degraded"
//   age ≥ 60 s             → "offline"
//   missing / invalid / negative / non-finite observation → "unknown"
//
// "unknown" is NEVER execution-ready. Only "fresh" is execution-ready, so an
// execution gate that used to accept age ≤ 15 s now accepts age < 15 s: one
// boundary point stricter, never looser.
//
// Out of scope (distinct concepts, separately named elsewhere, NOT forced onto
// these thresholds): account snapshots, market prices / feeds, position
// snapshots, cached broker-health verdicts and escalation timers.

/** A heartbeat younger than this is "fresh" (strictly less than). */
export const MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000;
/** A heartbeat this old or older is "offline". Between the two: "degraded". */
export const MT5_HEARTBEAT_OFFLINE_AT_MS = 60_000;

/** The same bounds in whole seconds, for display text and API "constants" blocks. */
export const MT5_HEARTBEAT_FRESH_BELOW_SECONDS = 15;
export const MT5_HEARTBEAT_OFFLINE_AT_SECONDS = 60;

export type HeartbeatFreshness = "fresh" | "degraded" | "offline" | "unknown";

export const HEARTBEAT_FRESHNESS_VALUES: readonly HeartbeatFreshness[] = [
  "fresh",
  "degraded",
  "offline",
  "unknown",
] as const;

function validAge(age: number | null | undefined): age is number {
  return typeof age === "number" && Number.isFinite(age) && age >= 0;
}

/**
 * Classify a heartbeat age in milliseconds. null / undefined / NaN /
 * ±Infinity / negative → "unknown".
 */
export function classifyHeartbeatAgeMs(ageMs: number | null | undefined): HeartbeatFreshness {
  if (!validAge(ageMs)) return "unknown";
  if (ageMs < MT5_HEARTBEAT_FRESH_BELOW_MS) return "fresh";
  if (ageMs < MT5_HEARTBEAT_OFFLINE_AT_MS) return "degraded";
  return "offline";
}

/**
 * Classify a heartbeat age in seconds. Exact for fractional seconds and for
 * Math.floor'ed whole seconds (floor(x) < 15 ⇔ x < 15). A Math.round'ed age can
 * only classify a half-second early (stricter), never late.
 */
export function classifyHeartbeatAgeSeconds(ageSeconds: number | null | undefined): HeartbeatFreshness {
  if (!validAge(ageSeconds)) return "unknown";
  return classifyHeartbeatAgeMs(ageSeconds * 1000);
}

/**
 * Age in ms of a heartbeat observation, or null when the observation is
 * missing or unparseable. A future-dated observation returns its negative age
 * so the classifier reports it as "unknown" (never fresh).
 */
export function heartbeatAgeMsFrom(
  lastHeartbeatAt: Date | string | number | null | undefined,
  nowMs: number,
): number | null {
  if (lastHeartbeatAt == null || !Number.isFinite(nowMs)) return null;
  const t =
    lastHeartbeatAt instanceof Date
      ? lastHeartbeatAt.getTime()
      : typeof lastHeartbeatAt === "number"
        ? lastHeartbeatAt
        : Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

/** Classify a heartbeat observation timestamp at `nowMs`. */
export function classifyHeartbeatAt(
  lastHeartbeatAt: Date | string | number | null | undefined,
  nowMs: number,
): HeartbeatFreshness {
  return classifyHeartbeatAgeMs(heartbeatAgeMsFrom(lastHeartbeatAt, nowMs));
}

/** Only a fresh heartbeat may satisfy an execution / dispatch requirement. */
export function heartbeatAllowsExecution(f: HeartbeatFreshness): boolean {
  return f === "fresh";
}

/**
 * The link is alive (fresh or degraded). Use for "connected" / "reachable"
 * displays; NEVER as an execution requirement.
 */
export function heartbeatIsOnline(f: HeartbeatFreshness): boolean {
  return f === "fresh" || f === "degraded";
}

/** Convenience: ms age is fresh (execution-ready). */
export function isHeartbeatAgeMsFresh(ageMs: number | null | undefined): boolean {
  return classifyHeartbeatAgeMs(ageMs) === "fresh";
}
/** Convenience: seconds age is fresh (execution-ready). */
export function isHeartbeatAgeSecondsFresh(ageSeconds: number | null | undefined): boolean {
  return classifyHeartbeatAgeSeconds(ageSeconds) === "fresh";
}
/** Convenience: ms age is online (fresh or degraded). */
export function isHeartbeatAgeMsOnline(ageMs: number | null | undefined): boolean {
  return heartbeatIsOnline(classifyHeartbeatAgeMs(ageMs));
}
/** Convenience: seconds age is online (fresh or degraded). */
export function isHeartbeatAgeSecondsOnline(ageSeconds: number | null | undefined): boolean {
  return heartbeatIsOnline(classifyHeartbeatAgeSeconds(ageSeconds));
}
