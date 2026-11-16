// A ready-now label describes a recent scan, never an indefinitely cached row.
export const SCANNER_MAP_MAX_AGE_MS = 30_000;
export const SCANNER_MAP_CLOCK_SKEW_MS = 5_000;

export function isScannerMapFresh(generatedAt: string | null | undefined, now: number): boolean {
  if (!generatedAt || !Number.isFinite(now)) return false;
  const time = Date.parse(generatedAt);
  return Number.isFinite(time) && time <= now + SCANNER_MAP_CLOCK_SKEW_MS &&
    now - time <= SCANNER_MAP_MAX_AGE_MS;
}

export function canUseScannerOpportunity(row: {
  generatedAt?: string | null;
  scanGeneratedAt?: string | null;
  dataStatus?: string;
  tradeable?: boolean;
}, now: number): boolean {
  return row.dataStatus === "live" && row.tradeable === true &&
    isScannerMapFresh(row.generatedAt, now) &&
    isScannerMapFresh(row.scanGeneratedAt, now);
}

/**
 * The next instant at which `isScannerMapFresh(generatedAt, now)` changes its
 * answer, or null when it never will (missing/invalid stamp, or already past
 * the maximum age). A stamp ahead of the clock first becomes fresh once the
 * clock is within the skew allowance, then expires at the maximum age. Lets
 * the map re-render exactly at the boundary instead of polling every second.
 */
export function nextScannerMapFreshnessChange(generatedAt: string | null | undefined, now: number): number | null {
  if (!generatedAt || !Number.isFinite(now)) return null;
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time)) return null;
  if (now < time - SCANNER_MAP_CLOCK_SKEW_MS) return time - SCANNER_MAP_CLOCK_SKEW_MS;
  if (now - time <= SCANNER_MAP_MAX_AGE_MS) return time + SCANNER_MAP_MAX_AGE_MS + 1;
  return null;
}
