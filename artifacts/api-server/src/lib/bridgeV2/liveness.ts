// ── ARX Bridge v2 — liveness facts (owner decision 18) ─────────────────────
//
// Pure. Splits what one Bridge v2 heartbeat age means into separately named
// facts so no surface confuses them:
//
//   heartbeatFreshness  — the COMPARABLE MT5 heartbeat fact, in the shared
//                         vocabulary (fresh / degraded / offline / unknown)
//                         from @workspace/domain/broker-health/heartbeatPolicy.
//   streamHealth        — Bridge v2 STREAM-specific health (LIVE ≤ 15 s,
//                         STALE ≤ 120 s, OFFLINE beyond, UNKNOWN when never
//                         seen). Observability only. Same values the legacy
//                         `freshness` / `feedFreshness` fields always carried.
//   connected           — legacy field, kept for response compatibility:
//                         stream LIVE (age ≤ 15 s), exactly as before.
//   streamImpliesExecutionReady — always `false`. A healthy stream (or a
//                         fresh heartbeat) never makes an account
//                         execution-ready; readiness is decided only by the
//                         dispatch gates (Phase B, demo dispatch, Risk
//                         Governor, Safety Core).

import {
  BRIDGE_V2_STREAM_LIVE_MS,
  BRIDGE_V2_STREAM_STALE_MS,
  classifyHeartbeatAgeMs,
  type HeartbeatFreshness,
} from "../brokerHub/freshness.js";

export type BridgeV2Freshness = "LIVE" | "STALE" | "OFFLINE" | "UNKNOWN";

export interface BridgeV2Liveness {
  heartbeatFreshness: HeartbeatFreshness;
  streamHealth: BridgeV2Freshness;
  connected: boolean;
  streamImpliesExecutionReady: false;
}

/** Stream-specific health bands (unchanged legacy semantics, inclusive). */
export function bridgeV2StreamHealth(ageMs: number | null): BridgeV2Freshness {
  if (ageMs == null) return "UNKNOWN";
  if (ageMs <= BRIDGE_V2_STREAM_LIVE_MS) return "LIVE";
  if (ageMs <= BRIDGE_V2_STREAM_STALE_MS) return "STALE";
  return "OFFLINE";
}

export function deriveBridgeV2Liveness(heartbeatAgeMs: number | null): BridgeV2Liveness {
  const streamHealth = bridgeV2StreamHealth(heartbeatAgeMs);
  return {
    heartbeatFreshness: classifyHeartbeatAgeMs(heartbeatAgeMs),
    streamHealth,
    connected: streamHealth === "LIVE",
    streamImpliesExecutionReady: false,
  };
}
