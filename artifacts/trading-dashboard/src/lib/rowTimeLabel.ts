// Time label for a row in a multi-day list. A time alone reads as today, so a
// row from an earlier day carries its date. An unparseable time says so
// instead of printing "Invalid Date".
export function rowTimeLabel(ts: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (ts == null) return "time not reported";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (!Number.isFinite(d.getTime())) return "time not reported";
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString();
  return d.toLocaleString(undefined, {
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
