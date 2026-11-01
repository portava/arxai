import { formatChartTime, type ChartTimeZone } from "./chartTimeZone";
/** This consumes normalized server evidence, not wire client claims. The
 * server currently registers no qualified live UTC clock adapter. */
export function originalUtcAuthority(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e=value as Record<string,unknown>;
  return e.kind === "original_utc" && e.basis === "UTC" && e.reason === null
    && typeof e.authority === "string" && e.authority.trim().length > 0 && e.authority.length <= 128
    ? e.authority : null;
}
export function chartUtcClockQualified(candles: readonly {timeBasisEvidence?:unknown}[]): boolean {
  if (!candles.length) return false;
  const first=originalUtcAuthority(candles[0]!.timeBasisEvidence);
  return first !== null && candles.every(c=>originalUtcAuthority(c.timeBasisEvidence)===first);
}
export const SOURCE_CLOCK_NOTE="Source clock · UTC mapping unverified. Candles remain visible; timezone conversion and UTC historical tests are unavailable.";
export function formatSourceChartTime(seconds:number, qualified:boolean, zone:ChartTimeZone="UTC", options:{seconds?:boolean}={}):string {
  const text=formatChartTime(seconds,qualified?zone:"UTC",options);
  return qualified ? text : text.replace(/ UTC$/, " source clock (UTC unverified)");
}
