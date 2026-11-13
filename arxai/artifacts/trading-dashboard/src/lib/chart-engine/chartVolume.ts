import type { CandleVolumeEvidence } from "@workspace/api-client-react";
import type { ChartStudy } from "./chartStudies";
export type { CandleVolumeEvidence } from "@workspace/api-client-react";

/** Volume is visible by default; saved study settings remain intact when hidden. */
export function chartDisplayStudies(studies: ChartStudy[], enabled: boolean, hasTicks: boolean, hasTrades: boolean): ChartStudy[] {
  const isVolume = (study: ChartStudy) => study.kind === "tick_volume" || study.kind === "trade_volume";
  if (!enabled) return studies.filter(study => !isVolume(study));
  if (studies.some(study => isVolume(study) && study.lineStyles?.[0]?.visible !== false)) return studies;
  return [...studies, { id: "arx-default-volume", kind: hasTrades && !hasTicks ? "trade_volume" : "tick_volume", period: 1, color: "#22c55e" }];
}

export function candleVolumeLabel(evidence: unknown): string {
  const ticks = observedTickVolume(evidence);
  if (ticks != null) return `Tick volume ${ticks.toLocaleString("en-US")}`;
  const trades = observedTradeVolume(evidence);
  return trades ? `Trade volume ${trades.quantity.toLocaleString("en-US")} units` : "Volume unavailable";
}
/** A count is not traded size. Other units are deliberately unsupported here. */
export function observedTickVolume(evidence: unknown): number | null {
  if (!evidence || typeof evidence !== "object") return null;
  const value=evidence as Partial<CandleVolumeEvidence>;
  return value.kind === "tick_count" && value.unit === "ticks" && value.reason === null &&
    typeof value.quantity === "number" && Number.isSafeInteger(value.quantity) && value.quantity >= 0
    ? value.quantity : null;
}
export const TRADE_VOLUME_AUTHORITY = "twelve-data:time-series:common-stock:regular-unadjusted:v1";
/** This producer currently proves positive quantities only. Zero is not treated
 * as an observed absence of trades, and missing numbers never become zero. */
export function observedTradeVolumeIdentity(evidence:unknown):string|null {
  if (!evidence || typeof evidence !== "object") return null;
  const value=evidence as Record<string,unknown>;
  return value.kind === "real_volume" && value.unit === "provider_trade_units" && value.reason === null &&
    value.authority === TRADE_VOLUME_AUTHORITY && typeof value.seriesIdentity === "string" && /^[a-f0-9]{64}$/.test(value.seriesIdentity) &&
    typeof value.quantity === "number" && Number.isSafeInteger(value.quantity) && value.quantity > 0
    ? value.seriesIdentity : null;
}
export function observedTradeVolume(evidence:unknown):{quantity:number;seriesIdentity:string}|null {
  const identity=observedTradeVolumeIdentity(evidence);
  return identity ? {quantity:(evidence as {quantity:number}).quantity,seriesIdentity:identity} : null;
}
/** Allocation-free hot-path snapshots. Existing tick/unavailable inputs retain
 * numeric storage; real-volume identity strings are retained, never concatenated. */
export function volumeInputQuantity(evidence:unknown):number {
  return observedTickVolume(evidence) ?? (observedTradeVolumeIdentity(evidence) ? (evidence as {quantity:number}).quantity : -1);
}
export function sameVolumeInput(a:unknown,b:unknown):boolean {
  return volumeInputQuantity(a)===volumeInputQuantity(b) && observedTradeVolumeIdentity(a)===observedTradeVolumeIdentity(b);
}
/** Only explicitly qualified MT5 ticks or audited stock trade-unit evidence may enter the chart calculation.
 * Missing legacy/provider numbers stay missing, including normalized zeros. */
export function chartVolumeEvidence(evidence: unknown, source: unknown): CandleVolumeEvidence | undefined {
  const trade=source === "assistant_real:twelve_data" ? observedTradeVolume(evidence) : null;
  if(trade)return {kind:"real_volume",quantity:trade.quantity,unit:"provider_trade_units",reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:trade.seriesIdentity};
  const quantity=source === "mt5_broker" ? observedTickVolume(evidence) : null;
  return quantity == null ? undefined : {kind:"tick_count",quantity,unit:"ticks",reason:null};
}
