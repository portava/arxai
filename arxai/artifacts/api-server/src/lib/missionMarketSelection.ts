import type { AgentProposal } from "@workspace/domain/profit-mission";
import { runSingleStrategy } from "./backtestStrategyRegistry.js";
import { quotePinForSeries, routeCandles, routeQuote } from "./data/marketDataRouter.js";
import type { ScannerOpportunity } from "./marketScanner.js";
import { classifyScannerQuoteBinding, prepareScannerCandles } from "./scannerInputIntegrity.js";

export async function scoutPaperMissionMarket(opp: ScannerOpportunity, proposalId: string): Promise<AgentProposal> {
  const { symbol, timeframe } = opp;
  const proposal: AgentProposal = {
    symbol, timeframe, proposalId, agentKey: "TREND", direction: "NONE", confidence: 0, urgency: "low",
    setupType: "Mission trend continuation", entryPlan: { entryPrice: null, entryZoneHigh: null, entryZoneLow: null },
    riskPlan: { stopLoss: null, takeProfit: null, expectedR: null, riskAmount: null }, warnings: [],
    reason: "Waiting for a verified live series and an executable bid and ask.", invalidationLevel: null,
    status: "context_only", riskObjection: null, judgeDecision: null, selectionReason: null, rejectionReason: null,
    marketSnapshot: { selectionModel: "mission_trend_continuation", dataSource: opp.dataSource, scannerRead: opp.finalRead?.label ?? null },
  };
  if (opp.dataSource !== "LIVE_FEED" || !opp.selectable || !opp.tradeable || !opp.chartConfirmed) return proposal;
  const timing = opp.timingContext;
  if (opp.newsContext?.eventRiskUnchecked || ["medium", "high", "critical"].includes(opp.newsContext?.riskLevel ?? "") ||
      ["REJECTED_BY_RISK", "SPREAD_TOO_HIGH", "CHOPPY_MARKET"].includes(opp.statusBadge) ||
      (timing?.timeframe === timeframe && ["NO_TRADE", "STAND_DOWN", "WAIT_NEWS"].includes(timing.entryPermission))) {
    proposal.reason = "Market risk, news or session conditions withhold this Mission setup.";
    return proposal;
  }

  const candles = await routeCandles(symbol, timeframe, 251).catch(() => null);
  if (!candles?.ok) {
    proposal.reason = "Live candle history is unavailable for this market.";
    return proposal;
  }
  const quote = await routeQuote(symbol, quotePinForSeries(candles)).catch(() => null);
  if (!quote?.ok) {
    proposal.reason = "A live quote from the candle provider is unavailable for this market.";
    return proposal;
  }
  const now = Date.now();
  const series = prepareScannerCandles(candles, symbol, timeframe, now);
  if (!series || series.trailingIntervals !== 1 || classifyScannerQuoteBinding(candles, quote, symbol, now).binding !== "BOUND" ||
      quote.quote?.bid == null || quote.quote.ask == null) return proposal;
  // The registered trend and chop rules consume OHLC only.
  const history = series.openClosed.slice(-250).map(bar => ({ ...bar, volume: bar.volume ?? 0 }));
  const signal = runSingleStrategy("trendContinuation", symbol, history, 60);
  proposal.reason = signal.reason;
  if (signal.direction === "WAIT") return proposal;
  const buy = signal.direction === "BUY", sign = buy ? 1 : -1;
  const entry = buy ? quote.quote.ask : quote.quote.bid;
  const liquidation = buy ? quote.quote.bid : quote.quote.ask;
  const risk = sign * (entry - signal.stopLoss), reward = sign * (signal.takeProfit - entry);
  if (!(risk > 0 && reward > 0 && sign * (liquidation - signal.stopLoss) > 0)) {
    proposal.reason = "The current bid and ask have moved outside the Mission bracket.";
    return proposal;
  }
  return { ...proposal, status: "proposed", direction: signal.direction, confidence: signal.score,
    urgency: signal.score >= 75 ? "high" : "medium", reason: signal.reason, invalidationLevel: String(signal.stopLoss),
    entryPlan: { ...proposal.entryPlan, entryPrice: entry },
    riskPlan: { stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, expectedR: reward / risk, riskAmount: null },
    marketSnapshot: { ...proposal.marketSnapshot, finalRead: "MISSION_TREND", barTime: series.openClosed.at(-1)?.time,
      quoteTime: quote.quote.timestamp, bid: quote.quote.bid, ask: quote.quote.ask, strategyScore: signal.score },
  };
}
