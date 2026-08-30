// Rendering helper for the timing-brain score family.
//
// Every score in `lib/domain/src/timing-brain/types.ts` that is expressed as a
// percentage is ALREADY on a 0-100 scale at the source:
//   - trapProbability   — trapRoomEngine.ts clamps to Math.min(100, Math.max(0, …))
//   - primaryConfidence / backupConfidence — heatEngine.ts emits 40-90
//   - fakeoutRisk       — sessionKillZoneEngine.ts constants are 20-60
//   - surpriseScore     — 0-100 (currently always null: never fabricated)
//
// The Heat Map page used to render these as `Math.round(v * 100)`, producing
// "Trap prob. 6000%". Use `scorePercent` at every render site so the fraction /
// percent confusion cannot come back one site at a time.
//
// This formats a value that is already a percentage. It does NOT convert a
// 0-1 fraction — a fraction has no place in this family.

/** Threshold (on the 0-100 scale) above which a trap probability is warned about. */
export const TRAP_WARNING_THRESHOLD = 50;

/**
 * Format an already-0-100 score as a percentage string.
 * Returns null-safe honest dash for a missing read — never a confident "0%".
 */
export function scorePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}
