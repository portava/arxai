// The pilot compares the actual owner-fleet winner with a veto applied after supervision.
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { atiShadowRunsTable as runs, db } from "@workspace/db";
import { ATI_DEFAULT_CHALLENGER } from "./atiCounterargument.js";
import { atiMt5QuoteAccount } from "../data/providers/mt5Provider.js";
import { atiInstrumentConflict } from "../data/atiBrokerInstrument.js";
import type { DecisionCandidate } from "@workspace/domain/self-trade";
import type { AtiDemoFleetComparison } from "./atiDemoFleetComparison.js";
import { publicDerivQuoteOrigin, type AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import type { MarketQuoteResult } from "../data/marketDataRouter.js";
import { evidenceMatches, isCurrentBuild, sameMarketReadSourceFamily } from "../truth/marketReadEvidence.js";
import type { SelfTradeObservationInput } from "./decisionEngine.js";
import type { atiFleetDecisionVersion } from "./atiStrategyOrigin.js";

import { ATI_FLEET_BASELINE, ATI_FLEET_SYMBOL } from "./atiFleetDefinition.js";
export { ATI_FLEET_BASELINE, ATI_FLEET_CAPTURE, ATI_FLEET_SCOPE, ATI_FLEET_SYMBOL } from "./atiFleetDefinition.js";

export type AtiFleetRead = { observation: SelfTradeObservationInput; priceOrigin: AtiDerivQuoteOrigin | null;
  demoPrice?: { receiptId: number; price: number } | null;
  alternate?: DecisionCandidate; demoFleetComparison?: AtiDemoFleetComparison };
export type AtiFleetReceipt = {
  cycleId: string; decisionId: number; cycleStartedAt: number;
  version: ReturnType<typeof atiFleetDecisionVersion>;
};

export function fleetPriceOrigin(routed: MarketQuoteResult | null) {
  if (!routed?.ok || !routed.quote || routed.symbol !== ATI_FLEET_SYMBOL ||
      routed.primaryProvider !== "deriv_public" || routed.tickTimeObserved !== true) return null;
  return publicDerivQuoteOrigin(routed.quote);
}

export function fleetDemoPrice(routed: MarketQuoteResult | null, observation: SelfTradeObservationInput, owner: number) {
  const origin = observation.mt5QuoteOrigin, bound = observation.boundQuote, q = routed?.quote, p = routed?.provenance;
  if (origin?.mode !== "DEMO" || !bound || !routed?.ok || routed.primaryProvider !== "mt5_broker" ||
      routed.tickTimeObserved !== true || routed.symbol !== observation.input.symbol ||
      !q || p?.source !== "LIVE_TICK" || p.delayed !== false || p.userId !== owner || p.bridgeConnectionId !== origin.bridgeConnectionId || p.brokerSymbol !== origin.brokerSymbol ||
      q.brokerSymbol !== origin.brokerSymbol || q.brokerClockMs !== origin.brokerTickAtMs ||
      q.bid !== bound.bid || q.ask !== bound.ask || q.timestamp !== bound.observedAt ||
      atiInstrumentConflict(routed.symbol, origin.brokerSymbol)) return null;
  const account = atiMt5QuoteAccount(q);
  if (account?.mode !== "DEMO" || account.binding !== origin.accountBinding || account.historyIdentity !== origin.historyIdentity ||
      account.receiptId !== origin.receiptId || account.streamKey !== origin.streamKey) return null;
  const price = q.last ?? (q.bid + q.ask) / 2;
  return Number.isFinite(price) && price > 0 && price === observation.input.currentPrice ? { receiptId: origin.receiptId, price } : null;
}

export function fleetInputGap(captured: AtiFleetRead, owner: number, at: number, allowDemo = false) {
  const { input, derivQuoteOrigin, boundQuote } = captured.observation;
  const { signal } = input;
  const primary = signal.marketEvidence;
  const demo = allowDemo && primary?.source === "mt5_broker" && captured.observation.mt5QuoteOrigin?.mode === "DEMO";
  if (input.symbol !== ATI_FLEET_SYMBOL || primary?.symbol !== input.symbol || (!demo && primary.source !== "deriv_public") ||
      !evidenceMatches(primary, primary, at, owner) || !isCurrentBuild(signal.generatedAt, at) ||
      signal.dataSource !== "LIVE_FEED" || !signal.hasSufficientData) return "PRIMARY_FEED_UNVERIFIED";
  if (input.htfSignals.some(s => s.marketEvidence?.timeframe !== "H1" ||
    !sameMarketReadSourceFamily(primary, s.marketEvidence ?? null) ||
    !evidenceMatches(s.marketEvidence, s.marketEvidence, at, owner) || !isCurrentBuild(s.generatedAt, at) ||
    s.dataSource !== "LIVE_FEED" || !s.hasSufficientData)) return "HIGHER_TIMEFRAME_FEED_UNVERIFIED";
  if (demo) return captured.demoPrice && captured.demoPrice.receiptId === captured.observation.mt5QuoteOrigin?.receiptId &&
    captured.demoPrice.price === input.currentPrice ? null : "FLEET_DEMO_PRICE_ORIGIN_UNVERIFIED";
  const price = captured.priceOrigin;
  if (!price || !derivQuoteOrigin || price.streamId !== derivQuoteOrigin.streamId || price.symbol !== "R_75" ||
      price.symbol !== derivQuoteOrigin.symbol || price.epoch !== derivQuoteOrigin.epoch ||
      !boundQuote || price.epoch * 1000 !== Date.parse(boundQuote.observedAt) ||
      input.currentPrice == null || !Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return "FLEET_PRICE_ORIGIN_UNVERIFIED";
  return null;
}

export function activeAtiFleetRuns(ownerId: number, cycleStartedAt: number) {
  const at = new Date(cycleStartedAt);
  return db.select().from(runs).where(and(eq(runs.ownerId, ownerId), eq(runs.baselineVersion, ATI_FLEET_BASELINE),
    eq(runs.challengerVersion, ATI_DEFAULT_CHALLENGER), eq(runs.symbol, ATI_FLEET_SYMBOL), isNull(runs.researchMode),
    or(isNull(runs.researchSource), eq(runs.researchSource, "deriv_public")),
    lte(runs.startedAt, at), gt(runs.endsAt, at)));
}
