// Market Brain — master orchestrator for all market intelligence modules
import type { Candle } from "../lib/strategyEngine.js";
import { generateSyntheticCandles, getMarketTypeForSymbol } from "../lib/strategyEngine.js";
import { getSymbolInfo } from "./symbols/symbolRegistry.js";
import { analyzeTechnical } from "./technical/technicalEngine.js";
import { analyzeMacro } from "./macro/macroEngine.js";
import { analyzeSession } from "./sessions/sessionEngine.js";
import { analyzeNewsRisk } from "./news/newsRiskEngine.js";
import {
  computeConfidence,
  computeNewsRiskPenalty,
  computeVolatilityPenalty,
  computeSpreadPenalty,
  computeStrategyMatchScore,
  type ConfluenceResult,
} from "./scoring/confluenceScoring.js";

export interface AccountState {
  balance: number;
  equity: number;
  openTrades: number;
  dailyDrawdown: number;
  maxDailyLoss: number;
  maxOpenTrades: number;
}

export interface BrainSettings {
  minConfidence?: number;
  enableNewsFilter?: boolean;
  enableSessionFilter?: boolean;
  enableMeanReversionInChop?: boolean;
}

export interface MarketBrainResult {
  symbol: string;
  category: string;
  direction: "BUY" | "SELL" | "WAIT";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  strategy: string;
  marketCondition: string;
  technicalBias: "Bullish" | "Bearish" | "Neutral";
  macroBias: string;
  session: string;
  newsRisk: string;
  riskApproved: boolean;
  blockedReason: string;
  reasons: string[];
  timestamp: string;
  scoring: ConfluenceResult;
  symbolInfo: {
    displayName: string;
    riskLevel: string;
    minimumConfidence: number;
    defaultRiskPerTrade: number;
    tradingSessions: string[];
    notes: string;
  } | null;
  technicalDetails: {
    trendDirection: string;
    trendStrength: number;
    emaAlignment: string;
    rsiState: string;
    rsiValue: number;
    atrState: string;
    atrValue: number;
    structure: string;
    liquiditySweep: string;
    chopScore: number;
    volatilityExpansion: boolean;
    supportLevels: number[];
    resistanceLevels: number[];
  };
  macroDetails: object;
  sessionDetails: {
    session: string;
    liquidityLevel: string;
    recommendedMarkets: string[];
    caution: string;
    sessionScore: number;
  };
  newsDetails: {
    majorNewsSoon: boolean;
    riskLevel: string;
    blockTrading: boolean;
    reason: string;
    nextEvent?: string;
  };
}

function determineDirection(
  technicalBias: "Bullish" | "Bearish" | "Neutral",
  macroBias: string,
  liquiditySweep: string,
  structure: string,
): "BUY" | "SELL" | "WAIT" {
  // Liquidity sweep overrides (reversal signal)
  if (liquiditySweep === "Bullish Sweep") return "BUY";
  if (liquiditySweep === "Bearish Sweep") return "SELL";

  // Both biases agree
  if (technicalBias === "Bullish" && macroBias === "Bullish") return "BUY";
  if (technicalBias === "Bearish" && macroBias === "Bearish") return "SELL";

  // Technical alone (macro neutral)
  if (macroBias === "Neutral" || macroBias === "Not news-driven") {
    if (technicalBias === "Bullish") return "BUY";
    if (technicalBias === "Bearish") return "SELL";
  }

  // Conflicting signals → WAIT
  return "WAIT";
}

function describeMarketCondition(technical: ReturnType<typeof analyzeTechnical>): string {
  if (technical.chopScore > 65) return "Choppy — No Trade Zone";
  if (technical.liquiditySweep !== "None") return `Liquidity Sweep (${technical.liquiditySweep})`;
  if (technical.volatilityExpansion && technical.trendDirection === "Bullish") return "Volatile Upside Breakout";
  if (technical.volatilityExpansion && technical.trendDirection === "Bearish") return "Volatile Downside Breakout";
  if (technical.structure === "Higher Highs" && technical.emaAlignment === "Full Bull") return "Strong Uptrend";
  if (technical.structure === "Lower Lows" && technical.emaAlignment === "Full Bear") return "Strong Downtrend";
  if (technical.structure === "Higher Highs") return "Uptrend — Pullback Opportunity";
  if (technical.structure === "Lower Lows") return "Downtrend — Short Opportunity";
  if (technical.structure === "Range") return "Range — Mean Reversion Setup";
  if (technical.atrState === "Contracting") return "Compression — Breakout Pending";
  return "Consolidation";
}

export function analyzeMarket(
  symbol: string,
  candles?: Candle[],
  accountState?: Partial<AccountState>,
  settings?: BrainSettings,
): MarketBrainResult {
  const timestamp = new Date().toISOString();
  const symbolInfo = getSymbolInfo(symbol);
  const category = symbolInfo?.category ?? getMarketTypeForSymbol(symbol);
  const minConfidence = settings?.minConfidence ?? symbolInfo?.minimumConfidence ?? 65;
  const candleData = candles ?? generateSyntheticCandles(symbol, 250);
  const price = candleData[candleData.length - 1]?.close ?? 0;

  // ─── Run all sub-engines ────────────────────────────────────────────────────
  const technical = analyzeTechnical(symbol, candleData);
  const macro = analyzeMacro(symbol, category);
  const session = analyzeSession(category, symbol);
  const newsRisk = analyzeNewsRisk(symbol, category);

  // ─── Strategy match score ────────────────────────────────────────────────────
  const { score: strategyMatchScore, bestStrategy } = computeStrategyMatchScore(
    technical.structure,
    technical.emaAlignment,
    technical.liquiditySweep,
    technical.rsiState,
    technical.volatilityExpansion,
    session.session,
  );

  // ─── Penalty computation ─────────────────────────────────────────────────────
  const newsRiskPenalty = (settings?.enableNewsFilter !== false) ? computeNewsRiskPenalty(newsRisk.riskLevel) : 0;
  const volatilityPenalty = computeVolatilityPenalty(technical.atrState, category);
  const spreadPenalty = computeSpreadPenalty(category, symbolInfo?.riskLevel ?? "Medium");

  // ─── Confluence score ────────────────────────────────────────────────────────
  const macroScore = macro.macroScore;
  const scoring = computeConfidence({
    technicalScore: technical.technicalScore,
    macroScore,
    sessionScore: session.sessionScore,
    strategyMatchScore,
    newsRiskPenalty,
    volatilityPenalty,
    spreadPenalty,
    category,
  });

  // ─── Direction decision ───────────────────────────────────────────────────────
  const macroBias = "macroBias" in macro ? String(macro.macroBias) : "Neutral";
  const rawDirection = determineDirection(technical.technicalBias, macroBias, technical.liquiditySweep, technical.structure);
  const marketCondition = describeMarketCondition(technical);

  // ─── Block rules ─────────────────────────────────────────────────────────────
  const blockedReasons: string[] = [];

  if (newsRisk.blockTrading && settings?.enableNewsFilter !== false) {
    blockedReasons.push(`News block: ${newsRisk.reason}`);
  }

  if (technical.chopScore > 70 && bestStrategy !== "Mean Reversion") {
    blockedReasons.push(`Chop filter: Choppy market (chop score ${technical.chopScore}/100) — no edge`);
  }

  if (scoring.confidence < minConfidence) {
    blockedReasons.push(`Confidence ${scoring.confidence}% below minimum ${minConfidence}% for ${symbol}`);
  }

  // V75 1s special rule — require higher confidence
  if (symbol === "Volatility 75 1s Index" && scoring.confidence < 80) {
    blockedReasons.push(`V75 1s requires confidence ≥80 (current: ${scoring.confidence}%) — WAIT`);
  }

  // Session filter
  if (settings?.enableSessionFilter !== false && category !== "synthetic" && session.sessionScore < 40) {
    blockedReasons.push(`Session filter: ${symbol} is not recommended during ${session.session} (low liquidity session)`);
  }

  // Account risk manager
  if (accountState) {
    const { openTrades = 0, maxOpenTrades = 5, dailyDrawdown = 0, maxDailyLoss = 1000 } = accountState;
    if (openTrades >= maxOpenTrades) blockedReasons.push(`Risk: Max open trades reached (${openTrades}/${maxOpenTrades})`);
    if (dailyDrawdown >= maxDailyLoss) blockedReasons.push(`Risk: Daily loss limit reached ($${dailyDrawdown.toFixed(2)} of $${maxDailyLoss})`);
  }

  const blocked = blockedReasons.length > 0;
  const direction = blocked ? "WAIT" : rawDirection;

  // ─── Trade levels ─────────────────────────────────────────────────────────────
  const atr = technical.atrValue || price * 0.001;
  let stopLoss = 0;
  let takeProfit = 0;
  let riskReward = 0;

  if (direction === "BUY") {
    stopLoss = price - atr * 1.5;
    takeProfit = price + atr * 2.5;
    riskReward = Math.round(((takeProfit - price) / (price - stopLoss)) * 100) / 100;
  } else if (direction === "SELL") {
    stopLoss = price + atr * 1.5;
    takeProfit = price - atr * 2.5;
    riskReward = Math.round(((price - takeProfit) / (stopLoss - price)) * 100) / 100;
  }

  // ─── Collect all reasons ──────────────────────────────────────────────────────
  const allReasons: string[] = [
    ...technical.reasons,
    ...("notes" in macro ? (macro as any).notes ?? [] : []),
    session.caution,
    newsRisk.reason,
    ...(blocked ? blockedReasons : [`Strategy match: ${bestStrategy} (score ${strategyMatchScore}/100)`, `Final confidence: ${scoring.confidence}%`]),
  ];

  return {
    symbol,
    category,
    direction,
    confidence: scoring.confidence,
    entry: Math.round(price * 100000) / 100000,
    stopLoss: Math.round(stopLoss * 100000) / 100000,
    takeProfit: Math.round(takeProfit * 100000) / 100000,
    riskReward,
    strategy: blocked ? "No Trade Filter" : bestStrategy,
    marketCondition,
    technicalBias: technical.technicalBias,
    macroBias,
    session: session.session,
    newsRisk: newsRisk.riskLevel,
    riskApproved: !blocked,
    blockedReason: blockedReasons.join(" | "),
    reasons: allReasons.filter(Boolean),
    timestamp,
    scoring,
    symbolInfo: symbolInfo ? { displayName: symbolInfo.displayName, riskLevel: symbolInfo.riskLevel, minimumConfidence: symbolInfo.minimumConfidence, defaultRiskPerTrade: symbolInfo.defaultRiskPerTrade, tradingSessions: symbolInfo.tradingSessions, notes: symbolInfo.notes } : null,
    technicalDetails: {
      trendDirection: technical.trendDirection,
      trendStrength: technical.trendStrength,
      emaAlignment: technical.emaAlignment,
      rsiState: technical.rsiState,
      rsiValue: technical.rsiValue,
      atrState: technical.atrState,
      atrValue: technical.atrValue,
      structure: technical.structure,
      liquiditySweep: technical.liquiditySweep,
      chopScore: technical.chopScore,
      volatilityExpansion: technical.volatilityExpansion,
      supportLevels: technical.supportLevels,
      resistanceLevels: technical.resistanceLevels,
    },
    macroDetails: macro,
    sessionDetails: { session: session.session, liquidityLevel: session.liquidityLevel, recommendedMarkets: session.recommendedMarkets, caution: session.caution, sessionScore: session.sessionScore },
    newsDetails: { majorNewsSoon: newsRisk.majorNewsSoon, riskLevel: newsRisk.riskLevel, blockTrading: newsRisk.blockTrading, reason: newsRisk.reason, nextEvent: newsRisk.nextEvent },
  };
}
