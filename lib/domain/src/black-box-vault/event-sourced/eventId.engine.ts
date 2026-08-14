// ═══════════════════════════════════════════════════════════════════════════
// Deterministic, monotonic event id generator.
// Format: ev_<ms-hex(12)>_<rand-hex(8)>
// Sortable by id when timestamps differ; collision-resistant within the
// same millisecond via the random suffix port.
// ═══════════════════════════════════════════════════════════════════════════

export type ClockPort = () => number;          // unix ms
export type RandomHexPort = (bytes: number) => string;

const MS_HEX_LEN = 12;

export function newEventId(clock: ClockPort, rand: RandomHexPort): string {
  const ms = Math.max(0, Math.floor(clock()));
  const hex = ms.toString(16).padStart(MS_HEX_LEN, "0");
  const tail = rand(4); // 8 hex chars
  return `ev_${hex}_${tail}`;
}

/** Reverse — useful for tests / monotonicity checks. */
export function eventIdTimestampMs(id: string): number | null {
  const m = /^ev_([0-9a-f]{1,16})_/.exec(id);
  if (!m || !m[1]) return null;
  return Number.parseInt(m[1], 16);
}
