// ── ARX Bridge v2 — per-connection transport clock-offset baseline ───────────
//
// WHY
//   Ingest grades every message's freshness on rawLatency =
//   serverReceivedAt - eaCreatedAt with a fixed 30s STALE cutoff. That number
//   is transport latency ONLY when the EA host clock agrees with the server
//   clock. An EA host >30s BEHIND grades every message STALE forever, so no
//   tick ever reaches the market-data store or the forming-bar composer — a
//   permanently frozen broker chart off a perfectly healthy feed. (The old
//   Math.max(0, ...) clamp meanwhile FORGAVE a clock that ran ahead, hiding
//   genuinely late replays from clock-ahead EAs.)
//
// WHAT
//   A per-(userId, bridgeConnectionId) running-minimum baseline of the SIGNED
//   raw difference. Real transport latency is additive non-negative noise on a
//   fixed clock offset, so the minimum over a connection's recent messages
//   converges on the clock offset itself. Freshness is then graded on
//   effectiveLatency = raw - baseline (>= 0 by construction), which restores
//   the gate's real meaning: "how late did THIS message arrive relative to the
//   fastest this connection has ever delivered".
//
// HONESTY / SAFETY POSTURE
//   - The correction feeds ONLY the in-memory market-data acceptance decision.
//     The trace row (bridge_v2_events) keeps the honestly MEASURED raw
//     transportLatencyMs + freshnessVerdict, exactly as observed — telemetry
//     is never rewritten to match a model.
//   - Warm-up fails closed: until TRANSPORT_BASELINE_MIN_SAMPLES messages have
//     been observed the RAW verdict stands (a single sample carries unknown
//     real latency, and trusting it would grade any replayed-old first message
//     LIVE). A clock-skewed EA is simply dropped for its first few messages —
//     today's behavior — then folds again.
//   - Per-connection state, reset on a sequence RESET verdict (an EA restart
//     may carry a different clock) and expired after idle silence.
//   - O(1) in-memory, never throws — it sits on the EA ingest hot path.

import { bridgeV2 } from "@workspace/domain";

const { classifyFreshness } = bridgeV2;

type FreshnessVerdict = ReturnType<typeof classifyFreshness>;

/** Messages observed before the baseline correction may be applied. */
export const TRANSPORT_BASELINE_MIN_SAMPLES = 5;
/** A connection silent this long re-anchors from scratch on its next message. */
export const TRANSPORT_BASELINE_IDLE_RESET_MS = 10 * 60_000;
// Bounded memory: connections beyond this evict the stalest entry first.
const MAX_TRACKED_CONNECTIONS = 512;

interface BaselineState {
  /** Running minimum of the signed raw diff — converges on the clock offset. */
  baselineMs: number;
  samples: number;
  lastSeenMs: number;
}

const baselines = new Map<string, BaselineState>();

function baselineKey(userId: number, bridgeConnectionId: number | null): string {
  return `${userId}:${bridgeConnectionId ?? "none"}`;
}

function evictStalest(nowMs: number): void {
  let stalestKey: string | null = null;
  let stalestSeen = Number.POSITIVE_INFINITY;
  for (const [k, s] of baselines) {
    if (nowMs - s.lastSeenMs > TRANSPORT_BASELINE_IDLE_RESET_MS) {
      baselines.delete(k);
      continue;
    }
    if (s.lastSeenMs < stalestSeen) {
      stalestSeen = s.lastSeenMs;
      stalestKey = k;
    }
  }
  if (baselines.size >= MAX_TRACKED_CONNECTIONS && stalestKey) baselines.delete(stalestKey);
}

export interface TransportGradeInput {
  userId: number;
  bridgeConnectionId: number | null;
  /** SIGNED serverReceivedAtEpochMs - eaCreatedAtEpochMs (NOT clamped to 0). */
  rawTransportDiffMs: number;
  /** The message's sequence verdict — RESET re-anchors the baseline. */
  sequenceVerdict: string | null;
  nowMs?: number;
}

/**
 * Observe one accepted message's signed transport diff and return the
 * skew-corrected freshness verdict for the market-data feed decision.
 * Returns the RAW verdict during warm-up (fail-closed) or on a non-finite
 * input. Pure in-memory arithmetic — cannot throw.
 */
export function gradeCorrectedTransportFreshness(input: TransportGradeInput): FreshnessVerdict {
  const raw = input.rawTransportDiffMs;
  const rawVerdict = classifyFreshness(Math.max(0, Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY));
  if (!Number.isFinite(raw)) return rawVerdict;
  const nowMs = input.nowMs ?? Date.now();
  const key = baselineKey(input.userId, input.bridgeConnectionId);

  let state = baselines.get(key);
  if (
    state &&
    (input.sequenceVerdict === "RESET" || nowMs - state.lastSeenMs > TRANSPORT_BASELINE_IDLE_RESET_MS)
  ) {
    // EA restart (fresh counter, possibly a fresh clock) or a long-idle
    // connection: the old offset is no longer evidence. Re-anchor.
    baselines.delete(key);
    state = undefined;
  }
  if (!state) {
    if (baselines.size >= MAX_TRACKED_CONNECTIONS) evictStalest(nowMs);
    baselines.set(key, { baselineMs: raw, samples: 1, lastSeenMs: nowMs });
    return rawVerdict;
  }

  state.baselineMs = Math.min(state.baselineMs, raw);
  state.samples += 1;
  state.lastSeenMs = nowMs;
  if (state.samples < TRANSPORT_BASELINE_MIN_SAMPLES) return rawVerdict;
  // The current message's own diff is already folded into the minimum, so the
  // effective latency is >= 0 by construction. Note this corrects BOTH ways:
  // a clock-behind EA stops false-STALE-ing, and a clock-ahead EA's genuinely
  // late replay stops hiding behind the old Math.max(0, ...) clamp.
  return classifyFreshness(Math.max(0, raw - state.baselineMs));
}

/** Test-only: clear all per-connection baseline state. */
export function __resetTransportClockBaselineForTests(): void {
  baselines.clear();
}
