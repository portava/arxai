// AI Strategy Brain — deterministic, simulator-only intelligence layer.
//
// SAFETY: Every output of this module is tagged dataSource="SIMULATOR" and
// never claims to use real broker data. Nothing in this file calls
// placeLiveOrderGuarded() or mutates live_positions / mt5_commands. All
// "analysis" is computed from the in-memory market simulator only.

import { marketSimulator } from "./marketSimulator.js";

const TRADING_STYLES = [
  "Scalping", "Intraday", "Swing", "News Avoidance", "Breakout",
  "Pullback", "Trend Continuation", "Reversal", "Liquidity Sweep", "Custom",
] as const;
export type TradingStyle = typeof TRADING_STYLES[number];
export const tradingStyles = TRADING_STYLES;

function clamp(n: number, lo = 0, hi = 100) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function round(n: number, d = 2) {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** d; return Math.round(n * m) / m;
}

export type AnalysisDataSource = "SIMULATOR" | "LIVE_FEED";
export type AnalysisExecutionEnvironment = "SIMULATOR" | "LIVE_FEED";

export interface MarketAnalysis {
  symbol: string;
  timeframe: string;
  marketBias: "bullish" | "bearish" | "neutral" | "choppy";
  trendStrength: number;
  setupQualityScore: number;
  entryQualityScore: number;
  riskScore: number;
  confidenceScore: number;
  recommendedAction: "BUY" | "SELL" | "WAIT" | "REJECT";
  entryZone: { low: number; high: number };
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  reasonForTrade: string;
  reasonToAvoid: string;
  invalidationReason: string;
  rulesPassed: string[];
  rulesFailed: string[];
  dataSource: AnalysisDataSource;
  executionEnvironment: AnalysisExecutionEnvironment;
  feedProvider?: string;
  generatedAt: string;
}

// Pure analysis shape — caller supplies candles + quote so the same logic
// can run over simulator candles OR real candles routed through the unified
// market data router. No fabricated data inside this helper.
export interface AnalysisCandle { o: number; h: number; l: number; c: number }
export interface AnalysisQuote { mid: number; spread: number }

export function analyzeMarketFromCandles(
  symbol: string,
  timeframe: string,
  candles: AnalysisCandle[],
  quote: AnalysisQuote,
  source: AnalysisDataSource,
  feedProvider?: string,
): MarketAnalysis {
  if (!candles?.length || !quote) {
    return {
      symbol, timeframe,
      marketBias: "neutral", trendStrength: 0, setupQualityScore: 0,
      entryQualityScore: 0, riskScore: 100, confidenceScore: 0,
      recommendedAction: "REJECT",
      entryZone: { low: 0, high: 0 }, stopLoss: 0, takeProfit: 0, riskRewardRatio: 0,
      reasonForTrade: "no data",
      reasonToAvoid: source === "LIVE_FEED"
        ? "Awaiting candles from live market data feed."
        : "Symbol not available in simulator.",
      invalidationReason: "no candles",
      rulesPassed: [], rulesFailed: ["data_available"],
      dataSource: source, executionEnvironment: source,
      feedProvider,
      generatedAt: new Date().toISOString(),
    };
  }

  const closes = candles.map((c) => c.c);
  return analyzeCore(symbol, timeframe, candles, closes, quote, source, feedProvider);
}

export function analyzeMarket(symbol: string, timeframe = "M15"): MarketAnalysis {
  const candles = marketSimulator.candlesFor(symbol, 30);
  const quote = marketSimulator.quote(symbol);
  if (!candles?.length || !quote) {
    return analyzeMarketFromCandles(symbol, timeframe, [], { mid: 0, spread: 0 }, "SIMULATOR");
  }
  return analyzeMarketFromCandles(
    symbol, timeframe,
    candles.map((c) => ({ o: c.o, h: c.h, l: c.l, c: c.c })),
    { mid: quote.mid, spread: quote.spread },
    "SIMULATOR",
  );
}

function analyzeCore(
  symbol: string,
  timeframe: string,
  candles: AnalysisCandle[],
  closes: number[],
  quote: AnalysisQuote,
  source: AnalysisDataSource,
  feedProvider?: string,
): MarketAnalysis {
  const first = closes[0]; const last = closes[closes.length - 1];
  const drift = (last - first) / first;
  const ranges = candles.map((c) => c.h - c.l);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastRange = ranges[ranges.length - 1];
  const volatilityRatio = avgRange > 0 ? lastRange / avgRange : 1;

  let marketBias: MarketAnalysis["marketBias"];
  if (Math.abs(drift) < 0.0005) marketBias = "neutral";
  else if (volatilityRatio > 1.8) marketBias = "choppy";
  else marketBias = drift > 0 ? "bullish" : "bearish";

  const trendStrength = clamp(Math.round(Math.abs(drift) * 50000));
  const spread = quote.spread;
  const spreadPenalty = clamp(Math.round((spread / quote.mid) * 100000), 0, 60);
  const setupQualityScore = clamp(40 + trendStrength / 2 - spreadPenalty / 2);
  const entryQualityScore = clamp(50 + (volatilityRatio < 1.3 ? 25 : -15));
  const riskScore = clamp(20 + spreadPenalty + (marketBias === "choppy" ? 30 : 0));
  const confidenceScore = clamp(Math.round((setupQualityScore + entryQualityScore + (100 - riskScore)) / 3));

  const dir: "BUY" | "SELL" = marketBias === "bullish" ? "BUY" : "SELL";
  const entry = quote.mid;
  const stopDistance = avgRange * 1.5;
  const stopLoss = round(dir === "BUY" ? entry - stopDistance : entry + stopDistance, 5);
  const takeProfit = round(dir === "BUY" ? entry + stopDistance * 2 : entry - stopDistance * 2, 5);
  const riskRewardRatio = 2.0;

  const rulesPassed: string[] = []; const rulesFailed: string[] = [];
  (trendStrength >= 40 ? rulesPassed : rulesFailed).push("trend_strength_>=_40");
  (volatilityRatio < 1.8 ? rulesPassed : rulesFailed).push("volatility_in_range");
  (spreadPenalty < 30 ? rulesPassed : rulesFailed).push("spread_acceptable");
  (riskRewardRatio >= 1.5 ? rulesPassed : rulesFailed).push("min_risk_reward_1.5");
  (confidenceScore >= 60 ? rulesPassed : rulesFailed).push("min_confidence_60");

  let recommendedAction: MarketAnalysis["recommendedAction"] = "WAIT";
  if (marketBias === "choppy" || rulesFailed.length >= 3) recommendedAction = "REJECT";
  else if (rulesFailed.length === 0 && (marketBias === "bullish" || marketBias === "bearish")) recommendedAction = dir;
  else if (rulesFailed.length <= 1 && (marketBias === "bullish" || marketBias === "bearish")) recommendedAction = "WAIT";

  return {
    symbol, timeframe, marketBias, trendStrength, setupQualityScore,
    entryQualityScore, riskScore, confidenceScore, recommendedAction,
    entryZone: { low: round(entry - avgRange * 0.25, 5), high: round(entry + avgRange * 0.25, 5) },
    stopLoss, takeProfit, riskRewardRatio,
    reasonForTrade: `${marketBias} bias on ${symbol} ${timeframe}; trend=${trendStrength}, spread ok, RR ${riskRewardRatio}`,
    reasonToAvoid: rulesFailed.length ? `Failed rules: ${rulesFailed.join(", ")}` : "",
    invalidationReason: dir === "BUY" ? `Close below ${stopLoss}` : `Close above ${stopLoss}`,
    rulesPassed, rulesFailed,
    dataSource: source, executionEnvironment: source,
    feedProvider,
    generatedAt: new Date().toISOString(),
  };
}

export interface TradeCard extends MarketAnalysis {
  cardId: string;
  positionSizingHint: { maxRiskUsd: number; suggestedLot: number };
  notes: string;
}
export function generateTradeCard(symbol: string, timeframe = "M15", maxRiskUsd = 20): TradeCard {
  const a = analyzeMarket(symbol, timeframe);
  const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stopPx = Math.abs((a.stopLoss || 0) - ((a.entryZone.low + a.entryZone.high) / 2));
  const suggestedLot = stopPx > 0 ? Math.max(0.01, Math.min(0.1, round(maxRiskUsd / (stopPx * 10000), 2))) : 0.01;
  return {
    ...a, cardId,
    positionSizingHint: { maxRiskUsd, suggestedLot },
    notes: a.recommendedAction === "REJECT"
      ? "Do not trade — setup quality below threshold."
      : `${a.recommendedAction} ${symbol} from ${a.entryZone.low}–${a.entryZone.high}, SL ${a.stopLoss}, TP ${a.takeProfit}. Simulator only.`,
  };
}

export interface EntrySniperScore {
  score: number;
  label:
    | "PERFECT_ENTRY_ZONE" | "GOOD_ENTRY" | "ACCEPTABLE_ENTRY"
    | "LATE_ENTRY" | "CHASED_ENTRY" | "DO_NOT_ENTER";
  factors: Record<string, number>;
  dataSource: "SIMULATOR";
}
export function entrySniperScore(input: {
  symbol: string; direction: "BUY" | "SELL"; entryPrice: number;
  stopLoss?: number; takeProfit?: number;
}): EntrySniperScore {
  const { symbol, direction, entryPrice, stopLoss, takeProfit } = input;
  const a = analyzeMarket(symbol);
  const idealMid = (a.entryZone.low + a.entryZone.high) / 2;
  const zoneWidth = Math.max(0.0000001, a.entryZone.high - a.entryZone.low);
  const distanceRatio = Math.abs(entryPrice - idealMid) / zoneWidth;

  const proximity = clamp(100 - distanceRatio * 60);
  const trendAlign = (direction === "BUY" && a.marketBias === "bullish") ||
                    (direction === "SELL" && a.marketBias === "bearish") ? 90 : 30;
  const stopOk = stopLoss != null
    ? clamp(80 - Math.abs(Math.abs(entryPrice - stopLoss) - Math.abs(entryPrice - (a.stopLoss || entryPrice))) * 50000)
    : 50;
  const rrOk = (takeProfit != null && stopLoss != null && entryPrice !== stopLoss)
    ? clamp(Math.round((Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss)) * 30))
    : 50;
  const spreadOk = clamp(100 - a.riskScore);
  const patience = a.marketBias === "choppy" ? 20 : 80;

  const factors = { proximity, trendAlign, stopOk, rrOk, spreadOk, patience };
  const score = clamp(Math.round(
    proximity * 0.30 + trendAlign * 0.20 + stopOk * 0.15 + rrOk * 0.15 + spreadOk * 0.10 + patience * 0.10,
  ));

  let label: EntrySniperScore["label"];
  if (score >= 90) label = "PERFECT_ENTRY_ZONE";
  else if (score >= 75) label = "GOOD_ENTRY";
  else if (score >= 60) label = "ACCEPTABLE_ENTRY";
  else if (score >= 45) label = "LATE_ENTRY";
  else if (score >= 30) label = "CHASED_ENTRY";
  else label = "DO_NOT_ENTER";

  return { score, label, factors, dataSource: "SIMULATOR" };
}

export interface TradeGrade {
  tradeGrade: "A+" | "A" | "B" | "C" | "D" | "F";
  overallScore: number;
  strengths: string[];
  weaknesses: string[];
  mistakesDetected: string[];
  improvementSuggestion: string;
  shouldHaveTakenTrade: boolean;
  dataSource: "SIMULATOR";
}
export function gradeTrade(input: {
  symbol: string; direction: "BUY" | "SELL"; entryPrice: number;
  stopLoss?: number; takeProfit?: number; lotSize?: number;
  confidenceScore?: number; reason?: string;
}): TradeGrade {
  const { symbol, direction, entryPrice, stopLoss, takeProfit, lotSize, confidenceScore } = input;
  const a = analyzeMarket(symbol);
  const sniper = entrySniperScore({ symbol, direction, entryPrice, stopLoss, takeProfit });

  const strengths: string[] = []; const weaknesses: string[] = []; const mistakes: string[] = [];
  if (sniper.factors.trendAlign >= 80) strengths.push("Aligned with prevailing trend");
  else { weaknesses.push("Counter-trend entry"); mistakes.push("traded against trend"); }
  if (sniper.factors.proximity >= 75) strengths.push("Entry near ideal zone");
  else if (sniper.factors.proximity < 45) { weaknesses.push("Chased the move"); mistakes.push("entered too late"); }
  if (sniper.factors.rrOk >= 60) strengths.push("Acceptable risk/reward");
  else { weaknesses.push("Sub-1:1.5 risk/reward"); mistakes.push("low risk/reward"); }
  if (a.marketBias === "choppy") { weaknesses.push("Choppy regime"); mistakes.push("traded during chop"); }
  if (a.riskScore > 60) { weaknesses.push("High spread / risk"); mistakes.push("ignored spread"); }
  if ((confidenceScore ?? 60) < 50) mistakes.push("low confidence trade");
  if ((lotSize ?? 0.01) > 0.5) mistakes.push("oversized position");
  if (mistakes.length === 0) mistakes.push("no mistake detected");

  const overallScore = clamp(Math.round(
    sniper.score * 0.40 + a.confidenceScore * 0.25 + (100 - a.riskScore) * 0.20 + (sniper.factors.rrOk) * 0.15,
  ));
  let tradeGrade: TradeGrade["tradeGrade"];
  if (overallScore >= 92) tradeGrade = "A+";
  else if (overallScore >= 82) tradeGrade = "A";
  else if (overallScore >= 70) tradeGrade = "B";
  else if (overallScore >= 58) tradeGrade = "C";
  else if (overallScore >= 45) tradeGrade = "D";
  else tradeGrade = "F";

  return {
    tradeGrade, overallScore, strengths, weaknesses,
    mistakesDetected: mistakes,
    improvementSuggestion: weaknesses[0]
      ? `Focus on: ${weaknesses[0].toLowerCase()} — wait for ${a.marketBias} confirmation and tighter spread before next entry.`
      : "Repeat this checklist on next setup; quality is acceptable.",
    shouldHaveTakenTrade: tradeGrade !== "F" && tradeGrade !== "D",
    dataSource: "SIMULATOR",
  };
}

// ── In-memory market replay ────────────────────────────────────────────────
interface ReplaySession {
  replayId: string; symbol: string; timeframe: string;
  strategy?: string;
  candles: ReturnType<typeof marketSimulator.candlesFor>;
  index: number;
  decisions: Array<{
    candleIndex: number; aiAction: string; entry?: number;
    stopLoss?: number; takeProfit?: number;
    confidenceScore: number; riskScore: number; reason: string;
  }>;
  startedAt: string;
}
const replays = new Map<string, ReplaySession>();
const REPLAY_TTL_MS = 60 * 60 * 1000; // 1 hour

// Sweep stale replay sessions every 5 minutes so abandoned tabs don't leak memory.
setInterval(() => {
  const cutoff = Date.now() - REPLAY_TTL_MS;
  for (const [id, s] of replays) {
    if (Date.parse(s.startedAt) < cutoff) replays.delete(id);
  }
}, 5 * 60 * 1000).unref?.();

export function replayStart(symbol: string, timeframe = "M15", strategy?: string) {
  const replayId = `replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const candles = marketSimulator.candlesFor(symbol, 60);
  const s: ReplaySession = {
    replayId, symbol, timeframe, strategy,
    candles, index: 0, decisions: [], startedAt: new Date().toISOString(),
  };
  replays.set(replayId, s);
  return s;
}
export function replayStep(replayId: string, humanAction?: string) {
  const s = replays.get(replayId); if (!s) return null;
  if (s.index >= s.candles.length) return { ...s, finished: true };
  const a = analyzeMarket(s.symbol, s.timeframe);
  const decision = {
    candleIndex: s.index, aiAction: a.recommendedAction,
    entry: (a.entryZone.low + a.entryZone.high) / 2,
    stopLoss: a.stopLoss, takeProfit: a.takeProfit,
    confidenceScore: a.confidenceScore, riskScore: a.riskScore,
    reason: a.reasonForTrade, humanAction,
  };
  s.decisions.push(decision); s.index += 1;
  return { replayId: s.replayId, candleIndex: decision.candleIndex, decision, totalCandles: s.candles.length };
}
export function replayStop(replayId: string) {
  const s = replays.get(replayId); if (!s) return null;
  const summary = { ...s, finished: true };
  replays.delete(replayId);
  return summary;
}
export function replayGet(replayId: string) {
  return replays.get(replayId) ?? null;
}
