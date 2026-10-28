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

// Status badges that describe the row as a setup to act on. Beside a withheld
// action ("No trade" / "Avoid for now") they would contradict the final read.
const POSITIVE_STATUS_BADGES = new Set(["HOT_SETUP"]);
const POSITIVE_GRADES = new Set(["ELITE", "STRONG"]);

export interface ScannerResultCardClaims {
  /** Show the opportunity grade word (ELITE / STRONG / …) and its colour. */
  showGrade: boolean;
  /** Show the server's status badge (e.g. "Hot setup"). */
  showStatusBadge: boolean;
  /** Left-border tone of the card. */
  borderTone: "positive" | "negative" | "info" | "neutral";
}

/**
 * What the rest of a legacy scanner result card may claim once the action
 * chip is known. When the server's final read withheld the action, an
 * ELITE / STRONG grade, a green border and a "Hot setup" badge would still
 * describe an elite setup to act on, so they are downgraded with it. The raw
 * opportunity score stays visible as a number, without the grade word.
 */
export function scannerResultCardClaims(
  chip: ScannerResultActionChip,
  opportunityLabel: string,
  statusBadge: string,
): ScannerResultCardClaims {
  if (chip.withheld) {
    return {
      showGrade: !POSITIVE_GRADES.has(opportunityLabel),
      showStatusBadge: !POSITIVE_STATUS_BADGES.has(statusBadge),
      borderTone: opportunityLabel === "REJECT" ? "negative" : "neutral",
    };
  }
  return {
    showGrade: true,
    showStatusBadge: true,
    borderTone: POSITIVE_GRADES.has(opportunityLabel) ? "positive" : opportunityLabel === "REJECT" ? "negative" : "info",
  };
}
