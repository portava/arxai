// Event countdown computed at RENDER time from the event's own timestamp.
//
// A server-computed minute offset ("minutesUntil", "timeUntilEventMinutes") is
// only true at the instant it was built; served from a cache or a stale query
// it kept saying "in 1m" after the release had started. Counting from the
// event time against the viewer's clock keeps every countdown current and
// keeps two countdowns for the same event in agreement.

/** "in 12m", "in under 1m", "just now", "5m ago"; "time unknown" for a bad time. */
export function eventCountdownLabel(eventTimeMs: number, nowMs: number): string {
  if (!Number.isFinite(eventTimeMs) || !Number.isFinite(nowMs)) return "time unknown";
  const d = eventTimeMs - nowMs;
  if (d >= 60_000) return `in ${Math.round(d / 60_000)}m`;
  if (d > 0) return "in under 1m";
  if (d > -60_000) return "just now";
  return `${Math.round(-d / 60_000)}m ago`;
}

/** Countdown from an ISO event time. */
export function eventCountdownFromIso(eventTimeIso: string | null | undefined, nowMs: number): string {
  return eventCountdownLabel(eventTimeIso ? Date.parse(eventTimeIso) : NaN, nowMs);
}
