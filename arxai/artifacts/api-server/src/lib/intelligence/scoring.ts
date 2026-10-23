// Phase UX2 — Deterministic trade-intelligence scoring.
//
// Pure function: same inputs → same scores. No fabrication.
// When required inputs are missing, the relevant score is null and the
// missing fields are listed in dataQuality.missing.
//
// SAFETY: scores are decision support only. They never trigger an order.
// `recommendedAction` is a suggestion — the user (or assistant) must
// still take an explicit confirmation step in the UI.

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

export type ScoringInput = {
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  /** MFE/MAE/peakPnl tracked across snapshots (see mfeTracker). */
  mfe?: number | null;
  mae?: number | null;
  peakPnl?: number | null;
  /** Minutes since the position opened. */
  ageMinutes?: number | null;
  /** Optional candle series (M15 or H1). When absent, trend/continuation
   *  scores are null. */
  candlesM15?: Candle[] | null;
  /** Optional ATR estimate in price units. */
  atr?: number | null;
  /** Spread in price units, if known. */
  spread?: number | null;
  /** User's preferred style (controls hold-time threshold for urgency). */
  style?: "scalping" | "intraday" | "swing" | "custom";
};

export type ScoringOutput = {
  scores: {
    continuationScore: number | null;
    pullbackScore: number | null;
    reversalRiskScore: number | null;
    fakeoutRiskScore: number | null;
    profitProtectionScore: number | null;
    closeUrgencyScore: number | null;
    holdConfidenceScore: number | null;
    trendStrengthScore: number | null;
    volatilityRiskScore: number | null;
    newsRiskScore: number | null;
  };
  derived: {
    pnlPips: number | null;
    profitGivebackPercent: number | null;
  };
  label: string;
  recommendedAction:
    | "HOLD" | "WATCH_CLOSELY" | "MOVE_STOP_TO_BREAKEVEN" | "TRAIL_STOP"
    | "PARTIAL_CLOSE" | "CLOSE_CONSIDERATION" | "CLOSE_NOW_PROMPT"
    | "NO_ACTION_DATA_INSUFFICIENT";
  explanation: string;
  dataQuality: {
    hasCurrentPrice: boolean;
    hasEntryPrice: boolean;
    hasStopLoss: boolean;
    hasTakeProfit: boolean;
    hasCandles: boolean;
    hasPnl: boolean;
    missing: string[];
  };
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

function pipsFor(symbol: string | undefined, priceDelta: number): number {
  // Very rough pip sizing — JPY pairs 0.01, others 0.0001. Falls back to delta*1.
  const s = (symbol ?? "").toUpperCase();
  if (s.includes("JPY")) return priceDelta / 0.01;
  if (s.length === 6) return priceDelta / 0.0001;
  return priceDelta;
}

export function computeTradeIntelligence(
  input: ScoringInput & { symbol?: string },
): ScoringOutput {
  const missing: string[] = [];
  const hasCurrentPrice = input.currentPrice != null;
  const hasEntryPrice = input.entryPrice != null;
  const hasStopLoss = input.stopLoss != null;
  const hasTakeProfit = input.takeProfit != null;
  const hasCandles = Array.isArray(input.candlesM15) && input.candlesM15.length >= 10;
  const hasPnl = input.unrealizedPnl != null;
  if (!hasCurrentPrice) missing.push("currentPrice");
  if (!hasEntryPrice) missing.push("entryPrice");
  if (!hasStopLoss) missing.push("stopLoss");
  if (!hasTakeProfit) missing.push("takeProfit");
  if (!hasCandles) missing.push("candlesM15");
  if (!hasPnl) missing.push("unrealizedPnl");

  // ── Derived: pips + profit giveback ──────────────────────────────────
  let pnlPips: number | null = null;
  if (hasEntryPrice && hasCurrentPrice) {
    const delta = (input.side === "BUY"
      ? input.currentPrice! - input.entryPrice!
      : input.entryPrice! - input.currentPrice!);
    pnlPips = Math.round(pipsFor(input.symbol, delta) * 10) / 10;
  }
  const peakPnl = input.peakPnl ?? input.mfe ?? null;
  let profitGivebackPercent: number | null = null;
  if (peakPnl != null && peakPnl > 0 && hasPnl) {
    profitGivebackPercent = Math.round(
      ((peakPnl - Math.max(0, input.unrealizedPnl!)) / peakPnl) * 100,
    );
    if (profitGivebackPercent < 0) profitGivebackPercent = 0;
    if (profitGivebackPercent > 100) profitGivebackPercent = 100;
  }

  // ── Distance to SL / TP (as % of entry) ──────────────────────────────
  let slDistPct: number | null = null;
  let tpDistPct: number | null = null;
  if (hasCurrentPrice && hasEntryPrice && hasStopLoss) {
    const total = Math.abs(input.entryPrice! - input.stopLoss!);
    const left = Math.abs(input.currentPrice! - input.stopLoss!);
    slDistPct = total > 0 ? clamp((left / total) * 100, 0, 100) : null;
  }
  if (hasCurrentPrice && hasEntryPrice && hasTakeProfit) {
    const total = Math.abs(input.takeProfit! - input.entryPrice!);
    const left = Math.abs(input.takeProfit! - input.currentPrice!);
    tpDistPct = total > 0 ? clamp(100 - (left / total) * 100, 0, 100) : null;
  }

  // ── Candle-based trend / volatility scores ───────────────────────────
  let trendStrengthScore: number | null = null;
  let continuationScore: number | null = null;
  let pullbackScore: number | null = null;
  let reversalRiskScore: number | null = null;
  let fakeoutRiskScore: number | null = null;
  let volatilityRiskScore: number | null = null;
  if (hasCandles) {
    const cs = input.candlesM15!;
    const tail = cs.slice(-20);
    const closes = tail.map((c) => c.c);
    const first = closes[0]!;
    const last = closes.at(-1)!;
    const rangeMag = Math.abs(last - first);
    // Trend strength: |slope| over volatility
    const ranges = tail.map((c) => c.h - c.l);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    if (avgRange > 0) {
      const slopeStrength = Math.min(1, rangeMag / (avgRange * tail.length * 0.3));
      trendStrengthScore = clamp(slopeStrength * 100);
    } else trendStrengthScore = 0;

    // Direction agreement with the trade side.
    const dirAgree = (input.side === "BUY" && last > first)
      || (input.side === "SELL" && last < first);

    // Higher-highs / lower-lows count over last 5 bars (continuation evidence)
    let agree = 0;
    for (let i = tail.length - 5; i < tail.length - 1; i++) {
      if (i < 1) continue;
      const prev = tail[i - 1]!.c, cur = tail[i]!.c;
      if (input.side === "BUY" && cur > prev) agree++;
      if (input.side === "SELL" && cur < prev) agree++;
    }
    continuationScore = clamp((dirAgree ? 50 : 20) + agree * 10);
    pullbackScore = clamp(dirAgree ? 100 - continuationScore + 20 : 30);
    reversalRiskScore = clamp(dirAgree ? 100 - continuationScore - 10 : 70);

    // Fakeout: long wick against trade side on last bar
    const lastBar = tail.at(-1)!;
    const body = Math.abs(lastBar.c - lastBar.o);
    const upperWick = lastBar.h - Math.max(lastBar.c, lastBar.o);
    const lowerWick = Math.min(lastBar.c, lastBar.o) - lastBar.l;
    const wickAgainst = input.side === "BUY" ? upperWick : lowerWick;
    if (lastBar.h - lastBar.l > 0) {
      fakeoutRiskScore = clamp((wickAgainst / (lastBar.h - lastBar.l)) * 100);
    } else fakeoutRiskScore = 0;

    // Volatility risk: avgRange relative to ATR (if provided) else relative to mean close.
    const meanClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    const volRel = input.atr && input.atr > 0
      ? avgRange / input.atr
      : meanClose > 0 ? (avgRange / meanClose) * 1000 : 0;
    volatilityRiskScore = clamp(Math.min(volRel * 50, 100));
  }

  // ── Profit-protection + close-urgency (work even without candles) ────
  let profitProtectionScore: number | null = null;
  let closeUrgencyScore: number | null = null;
  let holdConfidenceScore: number | null = null;
  if (hasPnl) {
    const pnl = input.unrealizedPnl!;
    const giveback = profitGivebackPercent ?? 0;
    // Protection rises with peak & giveback.
    if (peakPnl != null && peakPnl > 0) {
      profitProtectionScore = clamp(giveback * 0.9 + (pnl < peakPnl * 0.3 ? 30 : 0));
    } else {
      profitProtectionScore = clamp(pnl > 0 ? 20 : 0);
    }
    // Urgency rises with giveback, SL proximity, fakeoutRisk, hold time.
    let urg = 0;
    urg += giveback * 0.6;
    if (slDistPct != null) urg += (100 - slDistPct) * 0.3;
    if (fakeoutRiskScore != null) urg += fakeoutRiskScore * 0.2;
    if (reversalRiskScore != null) urg += reversalRiskScore * 0.2;
    const styleCap = input.style === "scalping" ? 30
      : input.style === "intraday" ? 240
      : input.style === "swing" ? 4320
      : 240;
    if (input.ageMinutes && input.ageMinutes > styleCap) urg += 20;
    if (pnl < 0 && slDistPct != null && slDistPct < 30) urg += 25;
    closeUrgencyScore = clamp(urg);

    // Hold confidence inverse of urgency, bounded by continuation evidence.
    const base = 100 - (closeUrgencyScore ?? 50);
    const contBoost = continuationScore != null ? (continuationScore - 50) * 0.3 : 0;
    holdConfidenceScore = clamp(base + contBoost);
  }

  // News risk requires economic calendar data — not wired yet.
  const newsRiskScore: number | null = null;

  // ── Label + recommended action ───────────────────────────────────────
  let label = "No clear signal";
  let recommendedAction: ScoringOutput["recommendedAction"] = "NO_ACTION_DATA_INSUFFICIENT";
  let explanation = "Not enough data yet to characterize this trade.";

  const haveCore = hasPnl && hasEntryPrice && hasCurrentPrice;
  if (haveCore) {
    const giveback = profitGivebackPercent ?? 0;
    const urg = closeUrgencyScore ?? 0;
    const cont = continuationScore ?? 0;
    const rev = reversalRiskScore ?? 0;
    const fake = fakeoutRiskScore ?? 0;
    const pnl = input.unrealizedPnl!;

    if (urg >= 80) {
      label = "Close consideration";
      recommendedAction = "CLOSE_NOW_PROMPT";
      explanation = `Close urgency is high (${urg}). Profit giveback ${giveback}%${slDistPct != null ? `, stop only ${100 - Math.round(slDistPct)}% away` : ""}.`;
    } else if (urg >= 60 || (giveback >= 50 && pnl > 0)) {
      label = "Protect profit";
      recommendedAction = "CLOSE_CONSIDERATION";
      explanation = `Profit faded ${giveback}% from peak. Consider partial close or moving stop.`;
    } else if (giveback >= 30 && pnl > 0) {
      label = "Profit fading";
      recommendedAction = "MOVE_STOP_TO_BREAKEVEN";
      explanation = `You've given back ${giveback}% of peak profit. Consider protecting what's left.`;
    } else if (hasCandles && fake >= 60) {
      label = "Possible fakeout";
      recommendedAction = "WATCH_CLOSELY";
      explanation = `Last bar shows a long wick against your direction (${fake}% body-to-wick).`;
    } else if (hasCandles && rev >= 65) {
      label = "Possible reversal";
      recommendedAction = "WATCH_CLOSELY";
      explanation = `Trend agreement is weak (${cont}) and reversal risk is rising (${rev}).`;
    } else if (hasCandles && cont >= 70 && pnl >= 0) {
      label = "Strong continuation";
      recommendedAction = "HOLD";
      explanation = `Direction agrees with the trade (continuation ${cont}). Holding looks reasonable.`;
    } else if (hasCandles && cont >= 50 && pnl >= 0) {
      label = "Healthy pullback";
      recommendedAction = "HOLD";
      explanation = `Mild retracement inside a still-aligned trend (continuation ${cont}).`;
    } else if (pnl >= 0) {
      label = "Wait for confirmation";
      recommendedAction = "WATCH_CLOSELY";
      explanation = `Trade is in profit but signal is mixed — wait for confirmation before adding risk.`;
    } else {
      label = "Wait for confirmation";
      recommendedAction = "WATCH_CLOSELY";
      explanation = `Trade is in drawdown; watch the stop level carefully.`;
    }
  } else if (hasPnl) {
    // We have P&L but not price context. Honest, partial answer.
    label = (input.unrealizedPnl ?? 0) >= 0 ? "Wait for confirmation" : "Wait for confirmation";
    recommendedAction = "WATCH_CLOSELY";
    explanation = "P&L is known but live price/SL context is missing — judgement is partial.";
  }

  return {
    scores: {
      continuationScore, pullbackScore, reversalRiskScore, fakeoutRiskScore,
      profitProtectionScore, closeUrgencyScore, holdConfidenceScore,
      trendStrengthScore, volatilityRiskScore, newsRiskScore,
    },
    derived: { pnlPips, profitGivebackPercent },
    label,
    recommendedAction,
    explanation,
    dataQuality: {
      hasCurrentPrice, hasEntryPrice, hasStopLoss, hasTakeProfit,
      hasCandles, hasPnl, missing,
    },
  };
}
