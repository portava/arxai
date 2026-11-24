import type { DecisionCandidate, DecisionCandidateInput } from "@workspace/domain/self-trade";
import { runDecisionPipeline } from "@workspace/domain/self-trade";
import { atiInstrumentConflict } from "../data/atiBrokerInstrument.js";
import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { bindBrokerQuote } from "../data/chart/brokerQuoteBinding.js";
import { computeBrokerPriceAlignment, hasMeasuredBrokerAlignment } from "../data/chart/brokerPriceAlignment.js";
import { computeChartGateOutput } from "../data/chart/chartGateOutput.js";
import type { getCachedIntelligenceContext } from "../data/chart/chartIntelligence.js";
import { computeChartTruthScore } from "../data/chart/chartTruthScore.js";
import { evidenceOfState } from "../data/chart/stateCandleWindow.js";
import { selfTradeChartConfirmation } from "./selfTradeChartConfirmation.js";
import { evidenceMatches } from "../truth/marketReadEvidence.js";

type Chart = ReturnType<typeof getCachedIntelligenceContext>;
type Quote = { bid: number; ask: number; observedAt: string };

// Read the exact cached chart and quote already captured for this decision. Never
// look up a newer quote, write the cached state, or submit either candidate.
export function compareAtiDemoChart(input: DecisionCandidateInput, baseline: DecisionCandidate,
  originalHandshake: DecisionCandidateInput["handshake"], chart: Chart, quote: Quote | null,
  origin: AtiMt5QuoteOrigin | null, owner: number, asOf: number) {
  const base = { version: "ati-demo-chart-comparison-v1", scope: "PRE_SUPERVISOR", evaluatedAt: asOf,
    baseline: { outcome: baseline.outcome, reason: baseline.reason }, executionAuthority: "NONE" } as const;
  const gap = (reason: string) => ({ ...base, state: "UNAVAILABLE" as const, reason, challenger: null });
  if (origin?.mode !== "DEMO") return gap("DEMO_ORIGIN_UNVERIFIED");
  if (!chart) return gap("CHART_CACHE_MISSING");
  const { state, seriesAttribution: series } = chart;
  const signal = input.signal.marketEvidence;
  const candle = state.latestClosedCandle;
  if (signal?.source !== "mt5_broker" || signal.symbol !== input.symbol || signal.timeframe !== input.timeframe ||
      state.symbol !== input.symbol || state.timeframe !== input.timeframe || !candle ||
      candle.symbol !== input.symbol || candle.timeframe !== input.timeframe || !candle.isComplete ||
      candle.isForming || candle.isFinal === false || Date.parse(candle.closeTime) !== Date.parse(signal.lastClosedCandleAt) ||
      !evidenceMatches(signal, evidenceOfState(state), asOf, owner)) return gap("CHART_DECISION_SERIES_UNVERIFIED");
  if (series?.providerId !== "mt5_broker" || series.bridgeConnectionId !== origin.bridgeConnectionId ||
      series.userId !== owner || series.brokerSymbol !== origin.brokerSymbol ||
      atiInstrumentConflict(input.symbol, origin.brokerSymbol)) return gap("CHART_DEMO_ORIGIN_MISMATCH");
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask <= quote.bid ||
      !Number.isFinite(Date.parse(quote.observedAt)) || Date.parse(quote.observedAt) > asOf) return gap("DECISION_QUOTE_UNVERIFIED");
  const binding = bindBrokerQuote({ series, requestingUserId: owner, now: asOf, quote: {
    providerId: "mt5_broker", userId: owner, bridgeConnectionId: origin.bridgeConnectionId, source: "mt5_live_quote",
    brokerSymbol: origin.brokerSymbol, environment: "demo", tickAt: quote.observedAt, bid: quote.bid, ask: quote.ask, spreadPoints: null,
  } });
  if (binding.status !== "BOUND") return gap(binding.reasons.join(","));
  const alignment = computeBrokerPriceAlignment({ chartPrice: candle.close, chartPriceBasis: chart.truthResult?.priceBasis ?? "UNKNOWN",
    assetClass: state.assetClass, brokerBid: quote.bid, brokerAsk: quote.ask, spreadPoints: null, quoteBinding: binding });
  if (!hasMeasuredBrokerAlignment(alignment)) return gap("BROKER_ALIGNMENT_UNMEASURED");
  const truth = computeChartTruthScore(chart.truthResult, chart.feedStatus, alignment);
  const gate = computeChartGateOutput(truth, state.chartReadScore, alignment, chart.truthResult, chart.feedStatus);
  const { allowed, reason } = selfTradeChartConfirmation({ gateOutput: gate, brokerAlignment: alignment, currentCandle: state.currentCandle });
  const handshake = allowed ? originalHandshake : { ...originalHandshake, ready: false,
    blocked: [...originalHandshake.blocked, "CHART_TRUTH_BLOCKED"] };
  const candidate = runDecisionPipeline({ ...input, handshake });
  return { ...base, state: "MEASURED" as const, chartAllowed: allowed, mode: origin.mode, receiptId: origin.receiptId,
    brokerSymbol: origin.brokerSymbol, sourceIdentity: signal.sourceIdentity, candleClosedAt: candle.closeTime,
    candlePrice: candle.close, priceBasis: alignment.chartPriceBasis, tickAt: quote.observedAt, bid: quote.bid, ask: quote.ask,
    tolerance: alignment.tolerance, deviationPct: alignment.deviationPct, chartTruthScore: truth.score,
    chartReason: reason,
    challenger: { outcome: candidate.outcome, reason: candidate.reason } };
}

export type AtiDemoChartComparison = ReturnType<typeof compareAtiDemoChart>;
