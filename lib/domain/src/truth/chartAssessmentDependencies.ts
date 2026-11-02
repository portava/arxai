/** Existing comparison intervals, shared by acquisition and observation.
 * Input is a canonical API timeframe. No fallback to the primary interval. */
export function assessmentHigherTimeframe(timeframe: string): string | null {
  return ({ M1: "M15", M5: "H1", M15: "H1", M30: "H4", H1: "H4", H4: "D1", D1: "W1" } as Record<string,string>)[timeframe] ?? null;
}

/** Stable observation identity, not a readiness verdict. Includes withheld
 * observations so transitions into/out of usable HTF data invalidate a read.
 * Source identifiers are the producer's opaque digests, never account numbers. */
export function higherTimeframeObservationKey(timeframe: string | null, response: unknown): string | null {
  if (!timeframe) return null;
  const r = response as Record<string, any> | null;
  const f = r?.feedStatus, e = r?.marketEvidence;
  const str = (v: unknown) => typeof v === "string" && v.length <= 512 ? v : null;
  return JSON.stringify([timeframe, str(r?.source), str(f?.source), r?.aiUsable === true,
    f?.aiUsable === true, typeof f?.stale === "boolean" ? f.stale : null,
    str(e?.symbol), str(e?.timeframe), str(e?.source), str(e?.sourceIdentity), str(e?.venueIdentity),
    str(e?.lastClosedCandleAt), str(e?.closedWindowIdentity), str(r?.symbol), str(r?.timeframe)]);
}

export function validHigherTimeframeObservationKey(value: unknown, timeframe: string | null): boolean {
  if (!timeframe) return value === null;
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const a = JSON.parse(value);
    return Array.isArray(a) && a.length === 15 && a[0] === timeframe
      && typeof a[3] === "boolean" && typeof a[4] === "boolean"
      && (a[5] === null || typeof a[5] === "boolean")
      && [1,2,6,7,8,9,10,11,12,13,14].every(i => a[i] === null || (typeof a[i] === "string" && a[i].length <= 512))
      && JSON.stringify(a) === value;
  } catch { return false; }
}
