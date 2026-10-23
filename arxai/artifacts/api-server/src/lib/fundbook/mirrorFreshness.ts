// ARX Fund Book — broker-mirror freshness classification (Task #131), pure.
//
// SAFETY / HONESTY (inviolable):
// - This is a 4-state freshness signal for the app-side broker mirror, derived
//   from the age of the broker heartbeat / last-positions-snapshot. It is a
//   visibility signal ONLY — it never auto-closes, never reconciles a position
//   out, and never touches any execution path (the 15s live-dispatch heartbeat
//   gate is unchanged and lives elsewhere).
// - MISSING means we have never received the signal (null age); it is NOT the
//   same as a flat broker — never fabricate freshness when we have no timestamp.

export type BrokerFreshness = "FRESH" | "DELAYED" | "STALE" | "MISSING";

// A broker sync inside FRESH_WINDOW_MS is live; up to DELAYED_WINDOW_MS is a
// lagging-but-recent mirror; older is stale; no timestamp at all is missing.
export const FRESH_WINDOW_MS = 15_000;
export const DELAYED_WINDOW_MS = 60_000;

/**
 * Classify a broker-mirror age (ms since the heartbeat / snapshot) into a
 * 4-state freshness. `ageMs` null ⇒ MISSING (no signal ever received).
 */
export function classifyBrokerFreshness(
  ageMs: number | null,
  opts: { freshMs?: number; delayedMs?: number; now?: number } = {},
): BrokerFreshness {
  if (ageMs == null || !Number.isFinite(ageMs)) return "MISSING";
  const freshMs = opts.freshMs ?? FRESH_WINDOW_MS;
  const delayedMs = opts.delayedMs ?? DELAYED_WINDOW_MS;
  if (ageMs <= freshMs) return "FRESH";
  if (ageMs <= delayedMs) return "DELAYED";
  return "STALE";
}

/** Age in ms of a timestamp relative to now, or null when the timestamp is null. */
export function ageMsOf(at: Date | number | null | undefined, now: number): number | null {
  if (at == null) return null;
  const t = at instanceof Date ? at.getTime() : at;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}
