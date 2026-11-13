/** Scheduled interval timer. It is independent of feed freshness and execution. */
export function candleCountdown(
  timeframe: string,
  now: number,
  barOpen: number | null,
): { remaining: number; scheduled: boolean } | null {
  if (!Number.isFinite(now)) return null;
  if (timeframe === "MN1") {
    const d = new Date(now),
      next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return {
      remaining: Math.max(0, Math.ceil((next - now) / 1000)),
      scheduled: true,
    };
  }
  const m = /^([MHDW])(\d+)$/.exec(timeframe);
  if (!m) return null;
  const duration =
    { M: 60, H: 3600, D: 86400, W: 604800 }[m[1] as "M" | "H" | "D" | "W"] *
    Number(m[2]) *
    1000;
  if (!duration) return null;
  if (
    barOpen != null &&
    Number.isFinite(barOpen) &&
    barOpen <= now &&
    barOpen + duration > now
  )
    return {
      remaining: Math.ceil((barOpen + duration - now) / 1000),
      scheduled: false,
    };
  // Weekly schedules begin on Monday UTC. Other intervals align to UTC epoch.
  const origin = m[1] === "W" ? Date.UTC(1970, 0, 5) : 0;
  const next = origin + (Math.floor((now - origin) / duration) + 1) * duration;
  return { remaining: Math.ceil((next - now) / 1000), scheduled: true };
}
export function countdownText(seconds: number): string {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return `${d ? `${d}d ` : ""}${h || d ? `${String(h).padStart(2, "0")}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
