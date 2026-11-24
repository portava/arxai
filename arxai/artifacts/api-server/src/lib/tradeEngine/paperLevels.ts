/**
 * The protective level crossed by this mark, or null if both are still open.
 * The simulator settles at the level. Market-priced orders use the executable quote.
 */
export function crossedPaperLevel(
  o: { direction: string; stopLoss: number; takeProfit?: number | null },
  px: number,
): { level: number; hit: "SL" | "TP" } | null {
  const tp = o.takeProfit ?? null;
  if (o.direction === "BUY") {
    if (px <= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px >= tp) return { level: tp, hit: "TP" };
  } else {
    if (px >= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px <= tp) return { level: tp, hit: "TP" };
  }
  return null;
}

/** Price at which the position can be liquidated on this two-sided quote. */
export function paperExitQuote(
  direction: string,
  q: { bid: number; ask: number },
): number {
  return direction === "BUY" ? q.bid : q.ask;
}

export type EntryReplayPolicy = { band?: { from: number; to: number }; maximumSpreadFractionOfStop?: number };
export type ObservedNoFillReason = "ENTRY_WINDOW_EXPIRED" | "BRACKET_INVALIDATED" | "FIRST_QUOTE_NOT_EXECUTABLE";
export type ObservedNoFill = { reason: ObservedNoFillReason; atMs: number; tapeHash?: string };

/** A deferred entry can arm only on an executable side inside its frozen band.
 * A bracket level observed before entry cancels the waiting hypothesis. */
export function retestQuoteDecision(
  plan: { action: "BUY" | "SELL"; stop: number; target: number },
  band: NonNullable<EntryReplayPolicy["band"]>,
  quote: { bid: number; ask: number },
  maximumSpreadFractionOfStop?: number,
) {
  if (crossedPaperLevel({ direction: plan.action, stopLoss: plan.stop, takeProfit: plan.target }, paperExitQuote(plan.action, quote))) {
    return "BRACKET_INVALIDATED";
  }
  const entry = plan.action === "BUY" ? quote.ask : quote.bid;
  const risk = plan.action === "BUY" ? entry - plan.stop : plan.stop - entry;
  if (maximumSpreadFractionOfStop != null && (risk <= 0 || (quote.ask - quote.bid) / risk >= maximumSpreadFractionOfStop)) return "WAIT";
  return entry >= band.from && entry <= band.to ? "AT_BAND" : "WAIT";
}

/** Receives each executable mark after the simulated entry on a validated quote prefix. */
export type ReplaySampleObserver = (entry: number, mark: number, releasedAt: number, archivePrefixHash?: string) => void;

export type ObservePricePoint = { atMs: number; price: number; receiptId?: number };
type Excursion = ObservePricePoint & { signedPriceUnits: number };
export type SampledBracketPath = {
  entry: ObservePricePoint;
  samples: number;
  favorable: Excursion | null;
  adverse: Excursion | null;
};

export function startSampledBracketPath(entry: ObservePricePoint): SampledBracketPath {
  return { entry, samples: 0, favorable: null, adverse: null };
}

export function recordBracketSample(path: SampledBracketPath, direction: "BUY" | "SELL", sample: ObservePricePoint) {
  const signedPriceUnits = (sample.price - path.entry.price) * (direction === "BUY" ? 1 : -1);
  path.samples++;
  if (signedPriceUnits > (path.favorable?.signedPriceUnits ?? 0)) path.favorable = { ...sample, signedPriceUnits };
  if (signedPriceUnits < (path.adverse?.signedPriceUnits ?? 0)) path.adverse = { ...sample, signedPriceUnits };
}
