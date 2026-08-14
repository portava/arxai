// Phase UX2 — Sniper Exit Alert engine.
//
// Given a freshly written snapshot + user preferences, returns the alerts
// that should be inserted. Dedups by recent (userId, tradeKey, alertType)
// so we don't spam the user — caller checks existing-recent before insert.

import type { ScoringOutput } from "./scoring.js";

export type TradeAlertPreferencesLike = {
  alertsEnabled: boolean;
  pushEnabled: boolean;
  inAppEnabled: boolean;
  style: string;
  sensitivity: string;
  profitGivebackPercent: number;
  minProfitBeforeAlert: number;
  maxHoldTimeMinutes: number;
  // UX3 — granular toggles
  alertBeforeTakeProfit: boolean;
  alertBeforeStopLoss: boolean;
  alertNearBreakeven: boolean;
  alertReversalRisk: boolean;
  // UX5 — Smart Exit Plan preferences
  exitStyle: string;
  partialClosePreference: string;
  moveStopToBreakevenPref: string;
  trailStopPref: string;
  alertOnStall: boolean;
  alertOnEfficiencyDrop: boolean;
  alertOnInvalidationBreak: boolean;
};

export const DEFAULT_PREFS: TradeAlertPreferencesLike = {
  alertsEnabled: true,
  pushEnabled: false,
  inAppEnabled: true,
  style: "intraday",
  sensitivity: "balanced",
  profitGivebackPercent: 35,
  minProfitBeforeAlert: 5,
  maxHoldTimeMinutes: 240,
  alertBeforeTakeProfit: true,
  alertBeforeStopLoss: true,
  alertNearBreakeven: true,
  alertReversalRisk: true,
  exitStyle: "balanced",
  partialClosePreference: "on",
  moveStopToBreakevenPref: "at_1r",
  trailStopPref: "after_1r",
  alertOnStall: true,
  alertOnEfficiencyDrop: true,
  alertOnInvalidationBreak: true,
};

export type AlertSpec = {
  alertType:
    | "profit_giveback" | "sl_approach" | "tp_approach"
    | "reversal_risk" | "fakeout_risk" | "close_urgency"
    | "news_risk" | "spread_risk" | "hold_time_exceeded"
    | "profit_target_hit" | "near_breakeven"
    // UX5 — Smart Exit Plan alerts
    | "protect_profit_reached" | "invalidation_breached"
    | "continuation_confirmed" | "efficiency_dropped"
    | "trade_stalled";
  severity: "info" | "watch" | "warning" | "urgent";
  title: string;
  message: string;
  recommendedAction: string | null;
  context: Record<string, unknown>;
};

export type AlertCtx = {
  symbol: string;
  side: "BUY" | "SELL";
  unrealizedPnl: number | null;
  peakPnl: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  ageMinutes: number | null;
  accountType: "demo" | "live" | "unknown";
  // UX5 — Smart Exit Plan context (optional). When present, enables the
  // protect_profit_reached / invalidation_breached / continuation_confirmed
  // / efficiency_dropped / trade_stalled alerts. All optional and gracefully
  // skipped when null.
  exitPlan?: {
    protectProfitLevel: number | null;
    invalidationLevel: number | null;
    continuationLevel: number | null;
    tradeEfficiencyScore: number | null;
  } | null;
  prefsUX5?: {
    alertOnStall: boolean;
    alertOnEfficiencyDrop: boolean;
    alertOnInvalidationBreak: boolean;
  };
};

function sensitivityFactor(sensitivity: string): number {
  if (sensitivity === "conservative") return 0.85;
  if (sensitivity === "aggressive") return 1.2;
  return 1.0;
}

export function evaluateAlerts(
  scoring: ScoringOutput, prefs: TradeAlertPreferencesLike, ctx: AlertCtx,
): AlertSpec[] {
  if (!prefs.alertsEnabled) return [];
  const out: AlertSpec[] = [];
  const f = sensitivityFactor(prefs.sensitivity);
  const sym = ctx.symbol;
  const sideTxt = ctx.side === "BUY" ? "buy" : "sell";

  const pnl = ctx.unrealizedPnl ?? 0;
  const peak = ctx.peakPnl ?? 0;
  const giveback = scoring.derived.profitGivebackPercent ?? 0;

  // 1. Profit giveback from peak — must be in profit & above min threshold.
  if (peak >= prefs.minProfitBeforeAlert && pnl > 0
      && giveback >= prefs.profitGivebackPercent * (1 / f)) {
    out.push({
      alertType: "profit_giveback",
      severity: giveback >= 60 ? "warning" : "watch",
      title: `Profit fading on ${sym}`,
      message: `Your ${sym} ${sideTxt} peaked at +${peak.toFixed(2)} and is now +${pnl.toFixed(2)} — ${giveback}% giveback. Consider protecting profit.`,
      recommendedAction: "MOVE_STOP_TO_BREAKEVEN",
      context: { symbol: sym, pnl, peakPnl: peak, givebackPct: giveback },
    });
  }

  // 2. SL approach — current within 30% of distance entry→SL toward SL.
  if (prefs.alertBeforeStopLoss && ctx.currentPrice != null && ctx.entryPrice != null && ctx.stopLoss != null) {
    const total = Math.abs(ctx.entryPrice - ctx.stopLoss);
    const dist = Math.abs(ctx.currentPrice - ctx.stopLoss);
    if (total > 0 && dist / total < 0.3 * f) {
      out.push({
        alertType: "sl_approach",
        severity: dist / total < 0.15 ? "urgent" : "warning",
        title: `Price approaching stop on ${sym}`,
        message: `Your ${sym} ${sideTxt} is ${Math.round((dist / total) * 100)}% of the way from entry to your stop loss.`,
        recommendedAction: "CLOSE_CONSIDERATION",
        context: { symbol: sym, distToSlPct: Math.round((dist / total) * 100) },
      });
    }
  }

  // 3. TP approach — current within 20% of TP.
  if (prefs.alertBeforeTakeProfit && ctx.currentPrice != null && ctx.entryPrice != null && ctx.takeProfit != null) {
    const total = Math.abs(ctx.takeProfit - ctx.entryPrice);
    const dist = Math.abs(ctx.takeProfit - ctx.currentPrice);
    if (total > 0 && dist / total < 0.2 * f && pnl > 0) {
      out.push({
        alertType: "tp_approach",
        severity: "watch",
        title: `Near take profit on ${sym}`,
        message: `Price is ${Math.round((1 - dist / total) * 100)}% of the way to your TP. Lock in or trail.`,
        recommendedAction: "TRAIL_STOP",
        context: { symbol: sym, distToTpPct: Math.round((dist / total) * 100) },
      });
    }
  }

  // 4/5/6. Score-based: reversal / fakeout / urgency.
  const rev = scoring.scores.reversalRiskScore ?? 0;
  const fake = scoring.scores.fakeoutRiskScore ?? 0;
  const urg = scoring.scores.closeUrgencyScore ?? 0;
  if (prefs.alertReversalRisk && rev >= 70 * (1 / f)) {
    out.push({
      alertType: "reversal_risk",
      severity: "warning",
      title: `Possible reversal on ${sym}`,
      message: `Momentum has weakened. Reversal risk is ${rev}/100.`,
      recommendedAction: "WATCH_CLOSELY",
      context: { reversalRiskScore: rev },
    });
  }
  if (fake >= 70 * (1 / f)) {
    out.push({
      alertType: "fakeout_risk",
      severity: "warning",
      title: `Possible fakeout on ${sym}`,
      message: `Long wick against your direction on the last bar. Fakeout risk ${fake}/100.`,
      recommendedAction: "WATCH_CLOSELY",
      context: { fakeoutRiskScore: fake },
    });
  }
  if (urg >= 75 * (1 / f)) {
    out.push({
      alertType: "close_urgency",
      severity: urg >= 90 ? "urgent" : "warning",
      title: `Close urgency rising on ${sym}`,
      message: `Close urgency is ${urg}/100. Tap to review a close ticket.`,
      recommendedAction: "CLOSE_NOW_PROMPT",
      context: { closeUrgencyScore: urg, accountType: ctx.accountType },
    });
  }

  // 7. Hold-time exceeded based on style.
  const cap = prefs.maxHoldTimeMinutes;
  if (ctx.ageMinutes != null && cap > 0 && ctx.ageMinutes > cap) {
    out.push({
      alertType: "hold_time_exceeded",
      severity: "info",
      title: `Holding longer than your ${prefs.style} window`,
      message: `${sym} ${sideTxt} has been open ${Math.round(ctx.ageMinutes)} min — beyond your ${cap} min target.`,
      recommendedAction: "WATCH_CLOSELY",
      context: { ageMinutes: ctx.ageMinutes, capMinutes: cap },
    });
  }

  // ── UX5 — Smart Exit Plan alerts ────────────────────────────────────
  const ep = ctx.exitPlan;
  const p5 = ctx.prefsUX5;
  const sideSign = ctx.side === "BUY" ? 1 : -1;
  if (ep && ctx.currentPrice != null) {
    // Protect-profit reached: price has moved to/past the protect-profit
    // level (entry + 1R in the user's favor).
    if (ep.protectProfitLevel != null
        && ((sideSign === 1 && ctx.currentPrice >= ep.protectProfitLevel)
        ||  (sideSign === -1 && ctx.currentPrice <= ep.protectProfitLevel))) {
      out.push({
        alertType: "protect_profit_reached",
        severity: "watch",
        title: `Protect-profit zone reached on ${sym}`,
        message: `Price tagged your protect-profit level (${ep.protectProfitLevel}). Consider reviewing stop to break-even or partial close.`,
        recommendedAction: "MOVE_STOP_TO_BREAKEVEN",
        context: { symbol: sym, level: ep.protectProfitLevel, currentPrice: ctx.currentPrice },
      });
    }
    // Invalidation breached: price has crossed the invalidation level (= SL).
    if (p5?.alertOnInvalidationBreak !== false && ep.invalidationLevel != null
        && ((sideSign === 1 && ctx.currentPrice <= ep.invalidationLevel)
        ||  (sideSign === -1 && ctx.currentPrice >= ep.invalidationLevel))) {
      out.push({
        alertType: "invalidation_breached",
        severity: "urgent",
        title: `Invalidation level broken on ${sym}`,
        message: `Price broke your invalidation level (${ep.invalidationLevel}). The thesis is no longer valid — review close immediately.`,
        recommendedAction: "CLOSE_NOW_PROMPT",
        context: { symbol: sym, level: ep.invalidationLevel, currentPrice: ctx.currentPrice },
      });
    }
    // Continuation confirmed: price has cleared the continuation level (1.5R).
    if (ep.continuationLevel != null
        && ((sideSign === 1 && ctx.currentPrice >= ep.continuationLevel)
        ||  (sideSign === -1 && ctx.currentPrice <= ep.continuationLevel))) {
      out.push({
        alertType: "continuation_confirmed",
        severity: "info",
        title: `Continuation confirmed on ${sym}`,
        message: `Price cleared your 1.5R continuation level (${ep.continuationLevel}). Consider trailing your stop to lock progress.`,
        recommendedAction: "TRAIL_STOP",
        context: { symbol: sym, level: ep.continuationLevel },
      });
    }
    // Efficiency dropped below threshold.
    if (p5?.alertOnEfficiencyDrop !== false && ep.tradeEfficiencyScore != null
        && ep.tradeEfficiencyScore < 35) {
      out.push({
        alertType: "efficiency_dropped",
        severity: ep.tradeEfficiencyScore < 20 ? "warning" : "watch",
        title: `Trade efficiency dropping on ${sym}`,
        message: `Trade efficiency is ${ep.tradeEfficiencyScore}/100 — the trade is no longer moving efficiently. Sniper exit review recommended.`,
        recommendedAction: "CLOSE_CONSIDERATION",
        context: { symbol: sym, tradeEfficiencyScore: ep.tradeEfficiencyScore },
      });
    }
    // Stalled — past 80% of style cap, low efficiency, low absolute P&L motion.
    if (p5?.alertOnStall !== false && ctx.ageMinutes != null) {
      // UX5 stall window is keyed off exitStyle (conservative/balanced/
      // aggressive), not the scalping/intraday/swing trading style.
      // Conservative exits expect quick progress; aggressive exits give
      // a trade more time before flagging stall.
      const exitStyle = prefs.exitStyle ?? "balanced";
      const baseCap = prefs.style === "scalping" ? 30
        : prefs.style === "intraday" ? 240
        : prefs.style === "swing" ? 4320 : prefs.maxHoldTimeMinutes;
      const exitStyleMult = exitStyle === "conservative" ? 0.6
        : exitStyle === "aggressive" ? 1.5 : 1.0;
      const styleCap = Math.max(1, Math.round(baseCap * exitStyleMult));
      if (ctx.ageMinutes > styleCap * 0.8
          && ep.tradeEfficiencyScore != null && ep.tradeEfficiencyScore < 50
          && Math.abs(pnl) < prefs.minProfitBeforeAlert) {
        out.push({
          alertType: "trade_stalled",
          severity: "watch",
          title: `${sym} has stalled`,
          message: `Open ${Math.round(ctx.ageMinutes)}m with efficiency ${ep.tradeEfficiencyScore}/100 and limited P&L progress. Consider reviewing close.`,
          recommendedAction: "CLOSE_CONSIDERATION",
          context: { symbol: sym, ageMinutes: ctx.ageMinutes, eff: ep.tradeEfficiencyScore },
        });
      }
    }
  }

  // 8. Near break-even after profit.
  if (prefs.alertNearBreakeven && peak >= prefs.minProfitBeforeAlert && pnl > -prefs.minProfitBeforeAlert * 0.2 && pnl < prefs.minProfitBeforeAlert * 0.2) {
    out.push({
      alertType: "near_breakeven",
      severity: "watch",
      title: `Profit returned to break-even on ${sym}`,
      message: `Trade peaked at +${peak.toFixed(2)} and is now near zero. Consider closing flat or reassessing.`,
      recommendedAction: "CLOSE_CONSIDERATION",
      context: { peakPnl: peak, pnl },
    });
  }

  return out;
}

// In-memory dedup cache helper for the route layer. Returns true when the
// alert should be skipped because we already alerted the same (userId,
// tradeKey, alertType) recently.
const SEVERITY_RANK: Record<string, number> = { info: 0, watch: 1, warning: 2, urgent: 3 };
export function shouldDedup(
  recent: Array<{ alertType: string; severity?: string | null; createdAt: Date }>,
  alertType: string,
  severity: "info" | "watch" | "warning" | "urgent" = "info",
  windowMs = 5 * 60_000,
): boolean {
  const now = Date.now();
  const newRank = SEVERITY_RANK[severity] ?? 0;
  // Within the cooldown window, dedup only when the recent alert of the same
  // type is at least as severe as the new one. If severity escalates (e.g.
  // profit_giveback watch → warning → urgent), the new alert fires immediately.
  return recent.some((r) => {
    if (r.alertType !== alertType) return false;
    if (now - r.createdAt.getTime() >= windowMs) return false;
    const oldRank = SEVERITY_RANK[String(r.severity ?? "info")] ?? 0;
    return oldRank >= newRank;
  });
}
