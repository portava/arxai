// Phase UX7 — Trade Decision Orchestrator (glue).
//
// Composes:
//   * resolved trade (resolveUserTrade)
//   * intelligence scoring (UX2)
//   * smart exit plan (UX5)
//   * market context + classifier + key levels + trade-context (UX6)
//   * user prefs (trade_alert_preferences) with sensible defaults
// into a single deterministic TradeDecision via `decide()`.
//
// SAFETY: never executes a trade. Never moves a stop. Never claims
// certainty. When inputs are missing, returns Data Insufficient.

import { db } from "@workspace/db";
import { tradeAlertPreferencesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { computeTradeIntelligence } from "../intelligence/scoring.js";
import { computeExitPlan } from "../intelligence/exitPlan.js";
import { buildMarketContext } from "../marketContext/contextBuilder.js";
import { classify } from "../marketContext/classifier.js";
import { computeKeyLevels } from "../marketContext/keyLevels.js";
import { buildTradeContext } from "../marketContext/tradeContext.js";

import { decide, type UserPrefsLike } from "./rules.js";
import type { TradeDecision } from "./types.js";

const DEFAULT_PREFS: UserPrefsLike = {
  style: "intraday",
  sensitivity: "balanced",
  exitStyle: "balanced",
  profitGivebackPercent: 35,
  partialClosePreference: "ask",
  moveStopToBreakevenPref: "ask",
  trailStopPref: "ask",
};

export async function loadUserDecisionPrefs(userId: number): Promise<UserPrefsLike> {
  const [row] = await db.select().from(tradeAlertPreferencesTable)
    .where(eq(tradeAlertPreferencesTable.userId, userId)).limit(1);
  if (!row) return DEFAULT_PREFS;
  return {
    style: (row.style ?? DEFAULT_PREFS.style) as string,
    sensitivity: (row.sensitivity ?? DEFAULT_PREFS.sensitivity) as string,
    exitStyle: (row.exitStyle ?? DEFAULT_PREFS.exitStyle) as string,
    profitGivebackPercent: row.profitGivebackPercent ?? DEFAULT_PREFS.profitGivebackPercent,
    partialClosePreference: (row.partialClosePreference ?? DEFAULT_PREFS.partialClosePreference) as string,
    moveStopToBreakevenPref: (row.moveStopToBreakevenPref ?? DEFAULT_PREFS.moveStopToBreakevenPref) as string,
    trailStopPref: (row.trailStopPref ?? DEFAULT_PREFS.trailStopPref) as string,
  };
}

export interface OrchestratorTrade {
  tradeKey: string;
  routingMode: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  lotSize: number;
  openedAt: Date | null;
}

export interface OrchestratorResult {
  decision: TradeDecision;
  ctx: Awaited<ReturnType<typeof buildMarketContext>>;
  classification: ReturnType<typeof classify>;
  keyLevels: ReturnType<typeof computeKeyLevels>;
  tradeContext: ReturnType<typeof buildTradeContext>;
  scoring: ReturnType<typeof computeTradeIntelligence>;
  exitPlan: ReturnType<typeof computeExitPlan>;
  prefs: UserPrefsLike;
}

export async function buildTradeDecision(
  trade: OrchestratorTrade,
  prefs: UserPrefsLike,
  opts?: { peakPnl?: number | null; mae?: number | null },
): Promise<OrchestratorResult> {
  const ageMinutes = trade.openedAt
    ? Math.floor((Date.now() - trade.openedAt.getTime()) / 60_000)
    : null;

  // Market context first — needed by scoring (atr) and key-levels.
  const ctx = await buildMarketContext({ symbol: trade.symbol });
  const classification = classify(ctx);

  const scoring = computeTradeIntelligence({
    side: trade.side, entryPrice: trade.entryPrice,
    currentPrice: trade.currentPrice, stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit, unrealizedPnl: trade.unrealizedPnl,
    mfe: null, mae: opts?.mae ?? null, peakPnl: opts?.peakPnl ?? null,
    ageMinutes, symbol: trade.symbol,
    atr: ctx.timeframes.M15?.atr ?? null,
    spread: ctx.spread,
    style: prefs.style as "scalping" | "intraday" | "swing" | "custom",
  });

  const exitPlan = computeExitPlan({
    symbol: trade.symbol, side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, peakPnl: opts?.peakPnl ?? null,
    mae: opts?.mae ?? null, ageMinutes,
    prefs: {
      style: prefs.style, exitStyle: prefs.exitStyle,
      sensitivity: prefs.sensitivity,
      profitGivebackPercent: prefs.profitGivebackPercent,
      maxHoldTimeMinutes: 480,
      partialClosePreference: prefs.partialClosePreference,
      moveStopToBreakevenPref: prefs.moveStopToBreakevenPref,
      trailStopPref: prefs.trailStopPref,
    },
    scoring,
  });

  const keyLevels = computeKeyLevels({
    side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    ctx, classification,
  });

  const tradeContext = buildTradeContext({
    side: trade.side,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl, peakPnl: opts?.peakPnl ?? null,
    ctx, classification, keyLevels,
  });

  const decision = decide({
    side: trade.side, symbol: trade.symbol,
    entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    unrealizedPnl: trade.unrealizedPnl,
    peakPnl: opts?.peakPnl ?? null, ageMinutes,
    scoring, exitPlan, ctx, classification, keyLevels, tradeContext, prefs,
  });

  // Fill cross-engine derived levels (orchestrator owns this, not rules).
  decision.invalidationLevel = keyLevels.invalidationLevel ?? exitPlan.invalidationLevel;
  decision.protectProfitLevel = exitPlan.protectProfitLevel;
  decision.continuationLevel = keyLevels.continuationLevel ?? exitPlan.continuationLevel;

  return { decision, ctx, classification, keyLevels, tradeContext, scoring, exitPlan, prefs };
}
