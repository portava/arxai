// Broker Hub — the one server place bridge / EA heartbeat and MT5 snapshot
// freshness is named (Tier 1 Broker State).
//
// MT5 CONNECTION HEARTBEATS (owner decision 17, 2026-10-25): one shared pure
// policy, defined in @workspace/domain/broker-health/heartbeatPolicy so the
// api-server, the pure domain evaluators and the trading dashboard all import
// the same classifier. It is re-exported here for server callers:
//   age < 15 s fresh · 15 s ≤ age < 60 s degraded · age ≥ 60 s offline ·
//   missing / invalid / negative / non-finite → unknown (never execution-ready).
// Callers compare through the classifier functions, never against a number,
// so `<` vs `<=` cannot drift. Guard:
// scripts/src/ci/check-single-bridge-freshness-source.ts.
//
// DISTINCT CONCEPTS (not heartbeats, kept separately named below with their
// own values): account snapshots, positions snapshots, the fund-book broker
// mirror, Bridge v2 stream health and the cached broker-health verdict.
// Market-data feeds live in lib/data/freshness.ts; escalation timers live
// with their owners.
//
// Pure: no IO.

export {
  MT5_HEARTBEAT_FRESH_BELOW_MS,
  MT5_HEARTBEAT_OFFLINE_AT_MS,
  MT5_HEARTBEAT_FRESH_BELOW_SECONDS,
  MT5_HEARTBEAT_OFFLINE_AT_SECONDS,
  HEARTBEAT_FRESHNESS_VALUES,
  type HeartbeatFreshness,
  classifyHeartbeatAgeMs,
  classifyHeartbeatAgeSeconds,
  classifyHeartbeatAt,
  heartbeatAgeMsFrom,
  heartbeatAllowsExecution,
  heartbeatIsOnline,
  isHeartbeatAgeMsFresh,
  isHeartbeatAgeSecondsFresh,
  isHeartbeatAgeMsOnline,
  isHeartbeatAgeSecondsOnline,
} from "@workspace/domain/broker-health/heartbeatPolicy";

// ── Bridge v2 stream health (stream-specific, not the heartbeat policy) ─────

/**
 * Bridge v2 STREAM health (lib/bridgeV2/status.ts, observability): LIVE up to
 * 15 s, STALE up to 120 s, OFFLINE beyond (inclusive). Stream-specific health,
 * separately named from the shared MT5 heartbeat policy (owner decision 18).
 */
export const BRIDGE_V2_STREAM_LIVE_MS = 15_000;
export const BRIDGE_V2_STREAM_STALE_MS = 120_000;

// ── Broker / account / positions snapshots ──────────────────────────────────

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

/**
 * 60 s — an MT5 positions / telemetry snapshot is fresh for this long
 * (connection card `marketDataHealth`, inclusive). A positions snapshot, not
 * a heartbeat: owner decision 17 keeps it off the heartbeat policy.
 */
export const MT5_POSITIONS_SNAPSHOT_FRESH_SECONDS = 60;

/**
 * 15 s / 60 s — fund-book broker-mirror freshness (inclusive: ≤ 15 s FRESH,
 * ≤ 60 s DELAYED). The age is the newer of the heartbeat and the positions
 * snapshot, so it is a mirror concept, kept off the heartbeat policy.
 */
export const FUNDBOOK_MIRROR_FRESH_MS = 15_000;
export const FUNDBOOK_MIRROR_DELAYED_MS = 60_000;

/** 120 s — the cached broker-health verdict is stale for the handshake monitor (advisory). */
export const BROKER_HEALTH_VERDICT_STALE_MS = 120_000;
