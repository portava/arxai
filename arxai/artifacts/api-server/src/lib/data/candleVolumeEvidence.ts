import { isOriginalTwelveDataStockEvidence } from "../assistant/twelveDataCandles.js";
import type { OriginalCandleContext } from "../assistant/polygonFxCandles.js";
/** Additive candle metadata. The legacy numeric volume field is ambiguous and
 * cannot establish either observed quantity or units. This is display evidence,
 * never liquidity, order-flow, execution size or trading permission. */
export interface CandleVolumeEvidence {
  kind: "tick_count" | "real_volume" | "unavailable";
  quantity: number | null;
  unit: "ticks" | "broker_units" | "provider_trade_units" | null;
  authority?: string | null;
  seriesIdentity?: string | null;
  reason: string | null;
}
export const unavailableCandleVolume = (reason: string): CandleVolumeEvidence => ({
  kind: "unavailable", quantity: null, unit: null, reason,
});
const validTickCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** Call at a producer boundary while the explicit tickVolume field still exists.
 * Never pass generic `volume`, realVolume or a legacy persisted alias here. */
export function mt5TickVolumeEvidence(tickVolume: unknown): CandleVolumeEvidence {
  return validTickCount(tickVolume)
    ? { kind: "tick_count", quantity: tickVolume, unit: "ticks", reason: null }
    : unavailableCandleVolume("The broker did not provide a valid explicit tick count for this candle.");
}
/** The normalizer qualifies evidence for its actual served source. Other sources
 * other than the audited stock endpoint remain withheld until their producer semantics are
 * positively established. In particular, MT5 real_volume=0 is not proof of zero
 * traded volume, and synthetic/mock data cannot borrow a broker's declaration. */
export function resolveCandleVolumeEvidence(evidence: unknown, source: string | null | undefined, context?: OriginalCandleContext & {candle:OriginalCandleContext["candle"] & {volume?:number;originalVolumeSeriesIdentity?:string}}): CandleVolumeEvidence {
  if(isOriginalTwelveDataStockEvidence(evidence,source,context,"volume"))return {...evidence as CandleVolumeEvidence};
  if (source !== "mt5_broker") return unavailableCandleVolume("Volume semantics are not qualified for this candle source.");
  if (evidence == null || typeof evidence !== "object") return unavailableCandleVolume("This candle has no original volume evidence; its legacy volume value is not a measured quantity.");
  const e = evidence as Partial<CandleVolumeEvidence>;
  if (e.kind === "tick_count" && e.unit === "ticks" && e.reason === null && validTickCount(e.quantity))
    return mt5TickVolumeEvidence(e.quantity);
  return unavailableCandleVolume("The candle's volume evidence is missing, inconsistent or unsupported; traded volume is not established.");
}
