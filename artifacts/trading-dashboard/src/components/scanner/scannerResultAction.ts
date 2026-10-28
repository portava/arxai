// The direction chip on a legacy scanner result card. The client may only
// DOWNGRADE the server's claim: when the server's own fused final read says
// there is no trade (NO_TRADE) or to avoid it for now (AVOID_FOR_NOW), the card
// must not still show the raw BUY / SELL action beside it.

export type ScannerFinalReadLabel =
  | "TRADE_WATCH"
  | "WAIT_FOR_CONFIRMATION"
  | "AVOID_FOR_NOW"
  | "NO_TRADE";

export interface ScannerResultActionChip {
  text: string;
  variant: "default" | "destructive" | "outline";
  /** True when the raw action was withheld because the final read said no. */
  withheld: boolean;
}

export function scannerResultActionChip(
  recommendedAction: string,
  finalReadLabel: string | null | undefined,
): ScannerResultActionChip {
  if (finalReadLabel === "NO_TRADE") return { text: "No trade", variant: "outline", withheld: true };
  if (finalReadLabel === "AVOID_FOR_NOW") return { text: "Avoid for now", variant: "outline", withheld: true };
  const variant = recommendedAction === "BUY" ? "default" : recommendedAction === "SELL" ? "destructive" : "outline";
  return { text: recommendedAction, variant, withheld: false };
}
