// ── ARX Bridge v2 — per-stream sequence + gap detection (Task #371) ──────────
//
// PURE: no IO. Given the last-seen sequence for a stream and an incoming one,
// classify the incoming message. The server persists last-seen per
// (userId, bridgeConnectionId, messageType, streamKey) and feeds it here.
//
// Why: the legacy bridge relied on polling + TTL — a dropped, duplicated, or
// reordered message was invisible. Bridge v2 makes transport integrity a
// first-class, observable fact without ever fabricating the missing data.

export type BridgeV2SequenceVerdict =
  | "FIRST" // first message ever seen on this stream
  | "IN_ORDER" // exactly lastSeen + 1
  | "GAP" // ahead of expected — one or more messages were lost
  | "DUPLICATE" // already seen (<= lastSeen) — drop, do not reprocess
  | "RESET"; // sequence went backwards to 0 — EA restarted its counter

export interface BridgeV2SequenceResult {
  verdict: BridgeV2SequenceVerdict;
  // How many messages are missing (only meaningful for GAP). >= 1 for a gap.
  gapSize: number;
  // The value to persist as the new last-seen (null = do not advance).
  nextLastSeen: number | null;
  // True when this message should be processed (FIRST/IN_ORDER/GAP/RESET).
  // DUPLICATE => false (idempotent drop).
  accept: boolean;
}

// EA restarts (terminal reboot, recompile) reset the counter. We treat a drop
// back to a small value after a high last-seen as a RESET, not a giant gap.
const RESET_BACKWARD_THRESHOLD = 0;

export function classifySequence(
  lastSeen: number | null,
  incoming: number,
): BridgeV2SequenceResult {
  if (!Number.isInteger(incoming) || incoming < 0) {
    // Malformed sequence — never advance, never accept. Validation should have
    // caught this; this is defence-in-depth.
    return { verdict: "DUPLICATE", gapSize: 0, nextLastSeen: lastSeen, accept: false };
  }

  if (lastSeen === null) {
    return { verdict: "FIRST", gapSize: 0, nextLastSeen: incoming, accept: true };
  }

  if (incoming === lastSeen + 1) {
    return { verdict: "IN_ORDER", gapSize: 0, nextLastSeen: incoming, accept: true };
  }

  if (incoming > lastSeen + 1) {
    return {
      verdict: "GAP",
      gapSize: incoming - lastSeen - 1,
      nextLastSeen: incoming,
      accept: true,
    };
  }

  // incoming <= lastSeen
  if (incoming <= RESET_BACKWARD_THRESHOLD && lastSeen > RESET_BACKWARD_THRESHOLD) {
    // Counter restarted at 0 — accept and re-anchor.
    return { verdict: "RESET", gapSize: 0, nextLastSeen: incoming, accept: true };
  }

  // Old or repeated sequence — duplicate. Drop without reprocessing or rewinding.
  return { verdict: "DUPLICATE", gapSize: 0, nextLastSeen: lastSeen, accept: false };
}

// Freshness verdict for an EA-created timestamp vs server-received time. Used to
// stamp latency + decide "live | delayed | stale | reconnecting" downstream.
export type BridgeV2FreshnessVerdict = "LIVE" | "DELAYED" | "STALE";

export interface BridgeV2FreshnessThresholds {
  liveMaxMs: number; // <= this => LIVE
  delayedMaxMs: number; // <= this => DELAYED, else STALE
}

export const DEFAULT_BRIDGE_V2_FRESHNESS: BridgeV2FreshnessThresholds = {
  liveMaxMs: 5_000,
  delayedMaxMs: 30_000,
};

export function classifyFreshness(
  ageMs: number,
  thresholds: BridgeV2FreshnessThresholds = DEFAULT_BRIDGE_V2_FRESHNESS,
): BridgeV2FreshnessVerdict {
  if (ageMs <= thresholds.liveMaxMs) return "LIVE";
  if (ageMs <= thresholds.delayedMaxMs) return "DELAYED";
  return "STALE";
}
