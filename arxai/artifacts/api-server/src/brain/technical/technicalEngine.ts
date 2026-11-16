import type { Candle } from "../../lib/strategyEngine.js";

export interface TechnicalAnalysis {
  trendDirection: "Bullish" | "Bearish" | "Neutral";
  trendStrength: number;
  emaAlignment: "Full Bull" | "Full Bear" | "Mixed Bull" | "Mixed Bear" | "Flat";
  rsiState: "Overbought" | "Oversold" | "Bullish" | "Bearish" | "Neutral";
  rsiValue: number;
  atrState: "Expanding" | "Contracting" | "Normal";
  atrValue: number;
  supportLevels: number[];
  resistanceLevels: number[];
  structure: "Higher Highs" | "Lower Lows" | "Range" | "Choppy" | "Breakout";
  liquiditySweep: "Bullish Sweep" | "Bearish Sweep" | "None";
  candleStrength: number;
  volatilityExpansion: boolean;
  chopScore: number;
  technicalBias: "Bullish" | "Bearish" | "Neutral";
  technicalScore: number;
  reasons: string[];
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

function ema(prices: number[], period: number): number[] {
  if (prices.length < period) return prices.map(() => prices[0]);
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? -c : 0));
  const avgG = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgL = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

function swingHighs(candles: Candle[], lookback = 3): number[] {
  const result: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const isSwing = candles.slice(i - lookback, i).every((x) => x.high <= c.high) &&
      candles.slice(i + 1, i + lookback + 1).every((x) => x.high < c.high);
    if (isSwing) result.push(c.high);
  }
  return result.slice(-5);
}

function swingLows(candles: Candle[], lookback = 3): number[] {
  const result: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const isSwing = candles.slice(i - lookback, i).every((x) => x.low >= c.low) &&
      candles.slice(i + 1, i + lookback + 1).every((x) => x.low > c.low);
    if (isSwing) result.push(c.low);
  }
  return result.slice(-5);
}

function detectStructure(candles: Candle[]): "Higher Highs" | "Lower Lows" | "Range" | "Choppy" | "Breakout" {
  if (candles.length < 20) return "Choppy";
  const highs = swingHighs(candles.slice(-30), 3);
  const lows = swingLows(candles.slice(-30), 3);
  const closes = candles.slice(-20).map((c) => c.close);
  const highRange = Math.max(...closes) - Math.min(...closes);
  const atrVal = atr(candles.slice(-20), 14);
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1] > highs[highs.length - 2];
    const hl = lows[lows.length - 1] > lows[lows.length - 2];
    const ll = lows[lows.length - 1] < lows[lows.length - 2];
    const lh = highs[highs.length - 1] < highs[highs.length - 2];
    if (hh && hl) return "Higher Highs";
    if (ll && lh) return "Lower Lows";
  }
  if (highRange < atrVal * 1.5) return "Range";
  return "Choppy";
}

function detectLiquiditySweep(candles: Candle[]): "Bullish Sweep" | "Bearish Sweep" | "None" {
  if (candles.length < 10) return "None";
  const recent = candles.slice(-10);
  const last = recent[recent.length - 1];
  const prevHighs = recent.slice(0, -1).map((c) => c.high);
  const prevLows = recent.slice(0, -1).map((c) => c.low);
  const prevHigh = Math.max(...prevHighs);
  const prevLow = Math.min(...prevLows);
  const wick = last.high - Math.max(last.open, last.close);
  const wickDown = Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open);
  if (last.high > prevHigh && last.close < prevHigh && wick > body) return "Bearish Sweep";
  if (last.low < prevLow && last.close > prevLow && wickDown > body) return "Bullish Sweep";
  return "None";
}

export function analyzeTechnical(symbol: string, candles: Candle[]): TechnicalAnalysis {
  const reasons: string[] = [];

  if (candles.length < 20) {
    return {
      trendDirection: "Neutral", trendStrength: 0, emaAlignment: "Flat", rsiState: "Neutral", rsiValue: 50,
      atrState: "Normal", atrValue: 0, supportLevels: [], resistanceLevels: [],
      structure: "Choppy", liquiditySweep: "None", candleStrength: 0, volatilityExpansion: false,
      chopScore: 80, technicalBias: "Neutral", technicalScore: 20, reasons: ["Insufficient candle data for technical analysis"],
    };
  }

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const rsiVal = rsi(closes.slice(-30), 14);
  const atrVal = atr(candles.slice(-20), 14);
  const atrHist = atr(candles.slice(-40, -20), 14);
  const atrState: "Expanding" | "Contracting" | "Normal" = atrVal > atrHist * 1.4 ? "Expanding" : atrVal < atrHist * 0.7 ? "Contracting" : "Normal";
  const volatilityExpansion = atrState === "Expanding";

  // EMA alignment
  const ema20arr = ema(closes, Math.min(20, closes.length - 1));
  const ema50arr = candles.length >= 50 ? ema(closes, 50) : null;
  const ema200arr = candles.length >= 200 ? ema(closes, 200) : null;
  const e20 = ema20arr[ema20arr.length - 1];
  const e50 = ema50arr ? ema50arr[ema50arr.length - 1] : e20;
  const e200 = ema200arr ? ema200arr[ema200arr.length - 1] : e50;

  let emaAlignment: TechnicalAnalysis["emaAlignment"] = "Flat";
  if (price > e20 && e20 > e50 && e50 > e200) { emaAlignment = "Full Bull"; reasons.push("Full EMA alignment (price > EMA20 > EMA50 > EMA200) — strong uptrend structure"); }
  else if (price < e20 && e20 < e50 && e50 < e200) { emaAlignment = "Full Bear"; reasons.push("Full bearish EMA alignment (price < EMA20 < EMA50 < EMA200) — strong downtrend structure"); }
  else if (price > e20 && e20 > e50) { emaAlignment = "Mixed Bull"; reasons.push("Partial bull EMA alignment — price and EMA20 above EMA50"); }
  else if (price < e20 && e20 < e50) { emaAlignment = "Mixed Bear"; reasons.push("Partial bear EMA alignment — price and EMA20 below EMA50"); }
  else { emaAlignment = "Flat"; reasons.push("EMA alignment mixed/flat — no clear directional bias"); }

  // RSI state
  let rsiState: TechnicalAnalysis["rsiState"] = "Neutral";
  if (rsiVal > 70) { rsiState = "Overbought"; reasons.push(`RSI ${rsiVal.toFixed(1)} — overbought zone, pullback/reversal risk`); }
  else if (rsiVal < 30) { rsiState = "Oversold"; reasons.push(`RSI ${rsiVal.toFixed(1)} — oversold zone, bounce/reversal potential`); }
  else if (rsiVal > 55) { rsiState = "Bullish"; reasons.push(`RSI ${rsiVal.toFixed(1)} — bullish momentum zone`); }
  else if (rsiVal < 45) { rsiState = "Bearish"; reasons.push(`RSI ${rsiVal.toFixed(1)} — bearish momentum zone`); }
  else { rsiState = "Neutral"; reasons.push(`RSI ${rsiVal.toFixed(1)} — neutral zone`); }

  // Support and resistance
  const recentCandles = candles.slice(-80);
  const supportLevels = swingLows(recentCandles).sort((a, b) => b - a);
  const resistanceLevels = swingHighs(recentCandles).sort((a, b) => b - a);

  // Market structure
  const structure = detectStructure(candles);
  reasons.push(`Market structure: ${structure}`);

  // Liquidity sweep
  const liquiditySweep = detectLiquiditySweep(candles);
  if (liquiditySweep !== "None") reasons.push(`Liquidity sweep detected: ${liquiditySweep}`);

  // Candle strength (last candle)
  const last = candles[candles.length - 1];
  const fullRange = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const candleStrength = fullRange > 0 ? Math.round((body / fullRange) * 100) : 0;
  if (candleStrength > 70) reasons.push(`Strong candle body (${candleStrength}% body ratio) — directional conviction`);

  // Chop score
  const last20 = candles.slice(-20);
  const highRange = Math.max(...last20.map((c) => c.close)) - Math.min(...last20.map((c) => c.close));
  const chopScore = Math.max(0, Math.min(100, Math.round((1 - highRange / (atrVal * 20 || 1)) * 100)));

  if (atrState === "Expanding") reasons.push("ATR expanding — volatility increasing, momentum entering");
  if (atrState === "Contracting") reasons.push("ATR contracting — volatility compressing, potential breakout building");

  // Technical bias and score
  let bullScore = 0;
  let bearScore = 0;
  if (emaAlignment === "Full Bull") bullScore += 30;
  else if (emaAlignment === "Mixed Bull") bullScore += 15;
  else if (emaAlignment === "Full Bear") bearScore += 30;
  else if (emaAlignment === "Mixed Bear") bearScore += 15;
  if (rsiState === "Bullish") bullScore += 15;
  else if (rsiState === "Bearish") bearScore += 15;
  else if (rsiState === "Overbought") bearScore += 10;
  else if (rsiState === "Oversold") bullScore += 10;
  if (structure === "Higher Highs") bullScore += 20;
  else if (structure === "Lower Lows") bearScore += 20;
  if (liquiditySweep === "Bullish Sweep") bullScore += 10;
  else if (liquiditySweep === "Bearish Sweep") bearScore += 10;
  if (volatilityExpansion) { bullScore += (bullScore > bearScore ? 5 : 0); bearScore += (bearScore > bullScore ? 5 : 0); }
  if (structure === "Choppy" || chopScore > 60) { bullScore = Math.max(0, bullScore - 20); bearScore = Math.max(0, bearScore - 20); }

  const net = bullScore - bearScore;
  const trendDirection: "Bullish" | "Bearish" | "Neutral" = net > 15 ? "Bullish" : net < -15 ? "Bearish" : "Neutral";
  const trendStrength = Math.min(100, Math.abs(net));
  const technicalBias: "Bullish" | "Bearish" | "Neutral" = trendDirection;
  const rawScore = 50 + net * 0.8;
  const technicalScore = Math.max(10, Math.min(95, Math.round(rawScore)));

  return {
    trendDirection, trendStrength, emaAlignment, rsiState, rsiValue: Math.round(rsiVal * 10) / 10,
    atrState, atrValue: Math.round(atrVal * 10000) / 10000, supportLevels, resistanceLevels,
    structure, liquiditySweep, candleStrength, volatilityExpansion, chopScore,
    technicalBias, technicalScore, reasons,
  };
}
