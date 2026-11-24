import { z } from "zod/v4";
import type { MarketCandlesResult, MarketQuoteResult } from "./marketDataRouter.js";
import { atiMt5QuoteAccount, mt5CandlesMatchHistory } from "./providers/mt5Provider.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const atiMt5QuoteOrigin = z.object({
  receiptId: z.number().int().positive(),
  streamKey: z.string().min(1).max(64),
  bridgeConnectionId: z.number().int().positive(),
  accountBinding: digest,
  historyIdentity: digest,
  mode: z.enum(["LIVE", "DEMO"]),
  brokerSymbol: z.string().min(1).max(128),
  brokerTickAtMs: z.number().int().positive(),
}).strict();
export type AtiMt5QuoteOrigin = z.infer<typeof atiMt5QuoteOrigin>;

/** Freeze the receipt only after the normal matchedMarketQuote checks pass. */
export function captureAtiMt5QuoteOrigin(candles: MarketCandlesResult, quote: MarketQuoteResult, ownerId: number) {
  const cp = candles.provenance;
  const qp = quote.provenance;
  if (!candles.ok || !quote.ok || candles.primaryProvider !== "mt5_broker" || quote.primaryProvider !== "mt5_broker" || !quote.quote ||
      quote.tickTimeObserved !== true || !cp || !qp || cp.userId !== ownerId || qp.userId !== ownerId ||
      qp.source !== "LIVE_TICK" || qp.delayed !== false ||
      cp.bridgeConnectionId !== qp.bridgeConnectionId || cp.brokerSymbol !== qp.brokerSymbol ||
      qp.brokerSymbol !== quote.quote.brokerSymbol) return null;
  const account = atiMt5QuoteAccount(quote.quote);
  if (!account?.historyIdentity || !cp.sourceId.endsWith(`:${account.historyIdentity}`) ||
      !mt5CandlesMatchHistory(candles.candles, account.historyIdentity)) return null;
  const parsed = atiMt5QuoteOrigin.safeParse({
    receiptId: account.receiptId, streamKey: account.streamKey, bridgeConnectionId: qp.bridgeConnectionId,
    accountBinding: account.binding, historyIdentity: account.historyIdentity, mode: account.mode,
    brokerSymbol: qp.brokerSymbol, brokerTickAtMs: quote.quote.brokerClockMs,
  });
  return parsed.success ? parsed.data : null;
}
