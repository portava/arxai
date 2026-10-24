// Broker Hub — the one place bridge / EA heartbeat and MT5 snapshot freshness
// thresholds are named (Tier 1 Broker State).
//
// Every surface that asks "is the bridge fresh / stale / offline" or "is the
// account snapshot fresh" imports its number from here instead of typing a
// literal. Guard: scripts/src/ci/check-single-bridge-freshness-source.ts.
//
// The values are exactly the ones each caller used before this module
// existed. Where two callers use DIFFERENT numbers for what reads like the
// same idea ("fresh" is 15 s at the dispatch gate, 20 s on the live-account
// pages, 30 s in the Risk Governor broker status and the platform EA views,
// 60 s in the read-only adapter), they are kept as separately named
// thresholds below. Unifying them would change what a surface reports and is
// an owner decision (docs/TIER1_BROKER_HUB_SOURCE.md, "Freshness thresholds").
//
// Pure constants and one pure classifier: no IO, no imports.

// ── EA / bridge heartbeat ───────────────────────────────────────────────────

/**
 * 15 s — the dispatch heartbeat gate (Phase B live gate #7). An EA heartbeat
 * at most this old is "fresh" / "live" / "stable". Used by the live and demo
 * dispatch gates, the EA self-update gate, the safety core (older → DEGRADED),
 * the bridge watchdog, readiness views and the paper-intelligence stale gate.
 */
export const EA_HEARTBEAT_FRESH_MS = 15_000;
export const EA_HEARTBEAT_FRESH_SECONDS = 15;

/**
 * 60 s — past this the bridge is stale / offline / not connected: watchdog
 * OFFLINE, safety-core LOCKDOWN, connection card DEGRADED, read-only adapter
 * heartbeat not fresh, broker provider not connected, Ruby's bridge status.
 */
export const EA_HEARTBEAT_STALE_MS = 60_000;
export const EA_HEARTBEAT_STALE_SECONDS = 60;

/**
 * 5 min — a long-dead heartbeat: user readiness "heartbeat stale", Ruby's
 * heartbeat tool "unhealthy".
 */
export const EA_HEARTBEAT_DEAD_MS = 5 * 60_000;
export const EA_HEARTBEAT_DEAD_SECONDS = 300;

/**
 * 20 s — the live-account pages' "heartbeat live" pill (meLiveAccount,
 * adminLiveAccount, adminAllocations). Differs from the 15 s gate.
 */
export const LIVE_ACCOUNT_HEARTBEAT_LIVE_MS = 20_000;

/**
 * 30 s / 120 s — broker heartbeat FRESH / DEGRADED bands: the Risk Governor's
 * broker status (fresh ≤ 30 s, degraded ≤ 2 min, then disconnected), the
 * platform EA (`mt5_state`) "connected" window in routes/mt5.ts, and the
 * trader dashboard's heartbeat card. "Fresh" here is 30 s, not the 15 s gate.
 */
export const BROKER_HEARTBEAT_FRESH_MS = 30_000;
export const BROKER_HEARTBEAT_FRESH_SECONDS = 30;
export const BROKER_HEARTBEAT_DEGRADED_MS = 120_000;
export const BROKER_HEARTBEAT_DEGRADED_SECONDS = 120;

/**
 * 90 s — advisory "bridge connected" for surfaces that only describe what a
 * submit would do (pending-order draft, Ruby's pending-submit probe), and the
 * reconciliation STALE_HEARTBEAT detector. Looser than the 60 s stale line.
 */
export const ADVISORY_BRIDGE_CONNECTED_MS = 90_000;

/** 120 s — Bridge v2 status: STALE up to this, OFFLINE beyond (observability). */
export const BRIDGE_V2_HEARTBEAT_STALE_MS = 120_000;

// ── Broker / account snapshots ──────────────────────────────────────────────

/**
 * 60 s — an MT5 broker/account snapshot is fresh for this long: read-only
 * adapter account snapshot, /mt5 bridge diagnostics broker snapshot, shared
 * master pool snapshot budget.
 */
export const MT5_ACCOUNT_SNAPSHOT_FRESH_MS = 60_000;

/**
 * Live account snapshot display bands (lib/live/liveAccountSnapshot.ts
 * defaults, tunable per call): ≤ 5 s live, ≤ 30 s fresh, ≤ 2 min delayed,
 * beyond stale. "Fresh" here is 30 s, not the 60 s MT5 snapshot window.
 */
export const ACCOUNT_SNAPSHOT_LIVE_MS = 5_000;
export const ACCOUNT_SNAPSHOT_FRESH_MS = 30_000;
export const ACCOUNT_SNAPSHOT_DELAYED_MS = 120_000;

/** 120 s — the cached broker-health verdict is stale for the handshake monitor (advisory). */
export const BROKER_HEALTH_VERDICT_STALE_MS = 120_000;

// ── Classifier ──────────────────────────────────────────────────────────────

export type AgeBand = "fresh" | "stale" | "offline" | "unknown";

/**
 * Classify an age against two thresholds in the SAME unit as the age (ms or
 * seconds; callers keep their own rounding). `inclusive` (default) means
 * age ≤ fresh is fresh and age ≤ stale is stale; `exclusive` uses < for both.
 * A null / non-finite age is "unknown"; callers decide what unknown means.
 */
export function classifyAge(
  age: number | null | undefined,
  fresh: number,
  stale: number,
  bound: "inclusive" | "exclusive" = "inclusive",
): AgeBand {
  if (age == null || !Number.isFinite(age)) return "unknown";
  const within = (limit: number) => (bound === "inclusive" ? age <= limit : age < limit);
  if (within(fresh)) return "fresh";
  if (within(stale)) return "stale";
  return "offline";
}
