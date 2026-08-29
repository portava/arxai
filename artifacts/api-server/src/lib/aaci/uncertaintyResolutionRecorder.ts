// AACI uncertainty-resolution recorder — the historical evidence base for the
// value-of-information (WAIT_FOR_EVIDENCE) advisory.
//
// Every AACI decision computes a per-channel uncertainty decomposition. This
// recorder keeps, per (userId, symbol) context, the previous decomposition and
// pairs it with the next one observed within a bounded gap — producing
// "did waiting actually resolve this channel?" observations. The VOI advisory
// estimates channel resolution rates ONLY from these recorded pairs.
//
// HONESTY: in-process and bounded. After a restart (or before enough pairs
// accumulate) the estimator reports INSUFFICIENT_HISTORY — never a made-up
// rate. Recording is observational only; it can never affect any decision
// output other than the journal-only advisory numbers.

import type {
  AaciChannelResolutionPair,
  AaciUncertaintyChannelName,
  AaciUncertaintyChannels,
} from "@workspace/domain/aaci";

interface ContextSnapshot {
  channels: AaciUncertaintyChannels;
  atMs: number;
}

/** Pairs further apart than this are not "one more bar of waiting". */
export const RESOLUTION_PAIR_MAX_GAP_MS = 15 * 60 * 1000; // 15 minutes
/** Pairs closer than this are the same evaluation, not new evidence. */
export const RESOLUTION_PAIR_MIN_GAP_MS = 1_000;

const MAX_CONTEXTS = 500;
const MAX_PAIRS = 5_000;

const lastByContext = new Map<string, ContextSnapshot>();
const pairs: AaciChannelResolutionPair[] = [];

function contextKey(userId: number, symbol: string): string {
  return `${userId}:${symbol}`;
}

/**
 * Record one per-channel observation for a context; emits resolution pairs
 * against the previous observation when the gap qualifies. Returns how many
 * pairs were recorded (0 when this is the first/too-close/too-old sample).
 */
export function recordUncertaintyObservation(
  userId: number,
  symbol: string,
  channels: AaciUncertaintyChannels,
  nowMs: number = Date.now(),
): number {
  if (!symbol) return 0;
  const key = contextKey(userId, symbol);
  const prev = lastByContext.get(key);

  let recorded = 0;
  if (prev) {
    const gap = nowMs - prev.atMs;
    if (gap >= RESOLUTION_PAIR_MIN_GAP_MS && gap <= RESOLUTION_PAIR_MAX_GAP_MS) {
      for (const name of Object.keys(channels) as AaciUncertaintyChannelName[]) {
        const before = prev.channels[name];
        const after = channels[name];
        if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
        pairs.push({ channel: name, penaltyBefore: before, penaltyAfter: after });
        recorded += 1;
      }
      if (pairs.length > MAX_PAIRS) pairs.splice(0, pairs.length - MAX_PAIRS);
    }
  }

  if (!lastByContext.has(key) && lastByContext.size >= MAX_CONTEXTS) {
    // Bounded memory: drop the stalest context.
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of lastByContext) {
      if (v.atMs < oldestAt) {
        oldestAt = v.atMs;
        oldestKey = k;
      }
    }
    if (oldestKey) lastByContext.delete(oldestKey);
  }
  lastByContext.set(key, { channels: { ...channels }, atMs: nowMs });
  return recorded;
}

/** All recorded resolution pairs (estimator input). */
export function getResolutionPairs(): AaciChannelResolutionPair[] {
  return [...pairs];
}

/** Tests only. */
export function clearResolutionRecorder(): void {
  lastByContext.clear();
  pairs.length = 0;
}
