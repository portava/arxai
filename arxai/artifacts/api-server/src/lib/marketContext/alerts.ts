// Phase UX6 — Market-context driven alert candidates.
//
// Pure function: takes (prior context, new context) and returns candidate
// alerts. The caller is responsible for dedup + persistence in the existing
// trade_exit_alerts table.

import type { ClassificationResult } from "./classifier.js";
import type { TradeContextResult } from "./tradeContext.js";
import type { KeyLevels } from "./keyLevels.js";

export type MarketAlertType =
  | "classification_flip" | "fakeout_risk_rising" | "invalidation_break"
  | "breakout_failed_back_inside" | "market_choppy"
  | "htf_trend_flipped" | "spread_dangerous";

export interface MarketAlertCandidate {
  alertType: MarketAlertType;
  severity: "info" | "watch" | "warning" | "urgent";
  title: string;
  message: string;
  recommendedAction: string;
  context: Record<string, unknown>;
}

export interface MarketAlertInput {
  symbol: string;
  side: "BUY" | "SELL";
  currentPrice: number | null;
  spread: number | null;
  classification: ClassificationResult;
  tradeContext: TradeContextResult;
  keyLevels: KeyLevels;
  // Optional prior snapshot to detect transitions.
  prior?: {
    classificationLabel?: string | null;
    fakeoutRiskScore?: number | null;
    trendAlignment?: string | null;
  } | null;
}

export function evaluateMarketContextAlerts(input: MarketAlertInput): MarketAlertCandidate[] {
  const out: MarketAlertCandidate[] = [];
  const { symbol, side, currentPrice, spread, classification, tradeContext, keyLevels, prior } = input;

  // 1. Classification flipped from continuation → reversal/fakeout.
  if (prior?.classificationLabel
      && /continuation|breakout/i.test(prior.classificationLabel)
      && /reversal|fakeout|failed/i.test(classification.label)) {
    out.push({
      alertType: "classification_flip",
      severity: "warning",
      title: `${symbol} flipped from ${prior.classificationLabel} to ${classification.label}`,
      message: `${classification.explanation} Consider reviewing the trade.`,
      recommendedAction: "OPEN_REVIEW_CLOSE",
      context: { from: prior.classificationLabel, to: classification.label },
    });
  }

  // 2. Fakeout risk crossed threshold upward.
  const fk = classification.scores.fakeoutRiskScore;
  if (fk != null && fk >= 65 && (prior?.fakeoutRiskScore ?? 0) < 65) {
    out.push({
      alertType: "fakeout_risk_rising",
      severity: "warning",
      title: `${symbol} fakeout risk rising`,
      message: `${classification.explanation}`,
      recommendedAction: "WATCH_CLOSELY",
      context: { fakeoutRiskScore: fk },
    });
  }

  // 3. Invalidation level broken.
  if (keyLevels.invalidationLevel != null && currentPrice != null) {
    const broken = side === "BUY"
      ? currentPrice < keyLevels.invalidationLevel
      : currentPrice > keyLevels.invalidationLevel;
    if (broken) {
      out.push({
        alertType: "invalidation_break",
        severity: "urgent",
        title: `${symbol} invalidation level broken`,
        message: `Price ${currentPrice} ${side === "BUY" ? "dropped below" : "rose above"} the invalidation level ${keyLevels.invalidationLevel}. The setup is invalidated on the primary timeframe.`,
        recommendedAction: "OPEN_REVIEW_CLOSE",
        context: { invalidationLevel: keyLevels.invalidationLevel, currentPrice },
      });
    }
  }

  // 4. Failed breakout — price back inside range.
  if (classification.label === "Failed breakout") {
    out.push({
      alertType: "breakout_failed_back_inside",
      severity: "warning",
      title: `${symbol} breakout failed`,
      message: classification.explanation,
      recommendedAction: "OPEN_REVIEW_CLOSE",
      context: {},
    });
  }

  // 5. Market choppy.
  if (classification.label === "Choppy / no clear edge") {
    out.push({
      alertType: "market_choppy",
      severity: "watch",
      title: `${symbol} is choppy`,
      message: classification.explanation,
      recommendedAction: "WATCH_CLOSELY",
      context: { chopRiskScore: classification.scores.chopRiskScore },
    });
  }

  // 6. HTF trend flipped against trade.
  if (prior?.trendAlignment === "ALIGNED" && tradeContext.trendAlignment === "FIGHTING") {
    out.push({
      alertType: "htf_trend_flipped",
      severity: "warning",
      title: `${symbol} higher-timeframe trend flipped against your trade`,
      message: tradeContext.exitHoldReview,
      recommendedAction: "OPEN_REVIEW_CLOSE",
      context: { trendAlignment: tradeContext.trendAlignment },
    });
  }

  // 7. Spread dangerous (only when known).
  if (spread != null && currentPrice && (spread / currentPrice) > 0.001) {
    out.push({
      alertType: "spread_dangerous",
      severity: "watch",
      title: `${symbol} spread looks wide`,
      message: `Current spread ${spread} is more than 0.1% of price. Execution costs may be elevated.`,
      recommendedAction: "WATCH_CLOSELY",
      context: { spread, spreadPct: (spread / currentPrice) * 100 },
    });
  }

  return out;
}
