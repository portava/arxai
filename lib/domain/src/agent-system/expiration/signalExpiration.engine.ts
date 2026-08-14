// signalExpiration — TTL rules for upstream sensor signals. Pure function.
//
// Different sensor signals decay at different rates:
//   ENTRY  — 15s  (price/orderflow facts go stale fast)
//   QUALITY — 60s (regime / vol context)
//   NEWS   — 300s (news-event proximity flags)

export const SIGNAL_TTL_MS = {
  ENTRY: 15_000,
  QUALITY: 60_000,
  NEWS: 300_000,
} as const;

export type SignalKind = keyof typeof SIGNAL_TTL_MS;

export interface SignalFreshness {
  kind: SignalKind;
  ageMs: number;
  ttlMs: number;
  fresh: boolean;
  reason: string;
}

export function isSignalFresh(emittedAtMs: number, ttlMs: number, nowMs: number): boolean {
  return nowMs - emittedAtMs <= ttlMs;
}

export function signalAgeMs(emittedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - emittedAtMs);
}

export function checkSignal(kind: SignalKind, emittedAtIso: string, now: Date): SignalFreshness {
  const emittedAtMs = Date.parse(emittedAtIso);
  const nowMs = now.getTime();
  const ttlMs = SIGNAL_TTL_MS[kind];
  const ageMs = signalAgeMs(emittedAtMs, nowMs);
  const fresh = ageMs <= ttlMs;
  return {
    kind, ageMs, ttlMs, fresh,
    reason: fresh
      ? `${kind} signal fresh (${ageMs}ms / ${ttlMs}ms)`
      : `${kind} signal STALE (${ageMs}ms > ${ttlMs}ms ttl)`,
  };
}
