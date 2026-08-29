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

interface ChannelSnapshot {
  penalty: number;
  atMs: number;
}

/** Pairs further apart than this are not "one more bar of waiting". */
export const RESOLUTION_PAIR_MAX_GAP_MS = 15 * 60 * 1000; // 15 minutes
/** Pairs closer than this are the same evaluation, not new evidence. */
export const RESOLUTION_PAIR_MIN_GAP_MS = 1_000;

const MAX_CONTEXTS = 500;
const MAX_PAIRS = 5_000;

// Per (userId:symbol) context → per-channel last observation. Storing per
// CHANNEL (not per full decomposition) lets the coverage worker record ONLY
// the channels it genuinely measures — an unmeasured channel simply has no
// snapshot and can never produce a fabricated pair.
const lastByContext = new Map<string, Map<AaciUncertaintyChannelName, ChannelSnapshot>>();
const pairs: AaciChannelResolutionPair[] = [];

function contextKey(userId: number, symbol: string): string {
  return `${userId}:${symbol}`;
}

function contextChannels(key: string): Map<AaciUncertaintyChannelName, ChannelSnapshot> {
  let m = lastByContext.get(key);
  if (m) return m;
  if (lastByContext.size >= MAX_CONTEXTS) {
    // Bounded memory: drop the stalest context (by its newest channel sample).
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, chans] of lastByContext) {
      let newest = 0;
      for (const s of chans.values()) newest = Math.max(newest, s.atMs);
      if (newest < oldestAt) {
        oldestAt = newest;
        oldestKey = k;
      }
    }
    if (oldestKey) lastByContext.delete(oldestKey);
  }
  m = new Map();
  lastByContext.set(key, m);
  return m;
}

/**
 * Record ONE channel's observation for a context; emits a resolution pair
 * against that channel's previous observation when the gap qualifies.
 * Returns 1 when a pair was recorded, else 0. This is the seam the coverage
 * worker uses: only genuinely MEASURED channels are ever recorded here.
 */
export function recordChannelObservation(
  userId: number,
  symbol: string,
  channel: AaciUncertaintyChannelName,
  penalty: number,
  nowMs: number = Date.now(),
): number {
  if (!symbol || !Number.isFinite(penalty)) return 0;
  const chans = contextChannels(contextKey(userId, symbol));
  const prev = chans.get(channel);

  let recorded = 0;
  if (prev) {
    const gap = nowMs - prev.atMs;
    if (gap >= RESOLUTION_PAIR_MIN_GAP_MS && gap <= RESOLUTION_PAIR_MAX_GAP_MS) {
      pairs.push({ channel, penaltyBefore: prev.penalty, penaltyAfter: penalty });
      if (pairs.length > MAX_PAIRS) pairs.splice(0, pairs.length - MAX_PAIRS);
      recorded = 1;
    }
  }
  chans.set(channel, { penalty, atMs: nowMs });
  return recorded;
}

/**
 * Record one full per-channel observation for a context; emits resolution
 * pairs against each channel's previous observation when the gap qualifies.
 * Returns how many pairs were recorded (0 when this is the first/too-close/
 * too-old sample).
 */
export function recordUncertaintyObservation(
  userId: number,
  symbol: string,
  channels: AaciUncertaintyChannels,
  nowMs: number = Date.now(),
): number {
  if (!symbol) return 0;
  let recorded = 0;
  for (const name of Object.keys(channels) as AaciUncertaintyChannelName[]) {
    recorded += recordChannelObservation(userId, symbol, name, channels[name], nowMs);
  }
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
