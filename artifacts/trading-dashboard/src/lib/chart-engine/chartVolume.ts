import type { CandleVolumeEvidence } from "@workspace/api-client-react";
export type { CandleVolumeEvidence } from "@workspace/api-client-react";
/** A count is not traded size. Other units are deliberately unsupported here. */
export function observedTickVolume(evidence: unknown): number | null {
  if (!evidence || typeof evidence !== "object") return null;
  const value=evidence as Partial<CandleVolumeEvidence>;
  return value.kind === "tick_count" && value.unit === "ticks" && value.reason === null &&
    typeof value.quantity === "number" && Number.isSafeInteger(value.quantity) && value.quantity >= 0
    ? value.quantity : null;
}
/** Only explicitly qualified MT5 bar evidence may enter the chart calculation.
 * Missing legacy/provider numbers stay missing, including normalized zeros. */
export function chartVolumeEvidence(evidence: unknown, source: unknown): CandleVolumeEvidence | undefined {
  const quantity=source === "mt5_broker" ? observedTickVolume(evidence) : null;
  return quantity == null ? undefined : {kind:"tick_count",quantity,unit:"ticks",reason:null};
}
