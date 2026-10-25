// Paper journal (paper_trades) facts for the Risk Governor and its read views.
//
// Facts only — no verdicts. The Risk Governor decides (./preTrade.ts rule 13);
// this file turns a trader's journal rows into the activity summary it reads,
// and gives the status screens the same numbers, so what a trader sees and
// what the governor enforces never drift apart.

import type { PaperTrade } from "@workspace/db";
import { summarizeActivity, type TradingActivity } from "./preTrade.js";

/** Column defaults of user_risk_settings, used when a trader has no row yet. */
export const DEFAULT_USER_RISK_SETTINGS = {
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null as number | null,
  maxDailyLossPercent: 3, maxDailyLossAmount: null as number | null,
  maxWeeklyLossPercent: null as number | null, maxWeeklyLossAmount: null as number | null,
  maxOpenTrades: 3, maxTradesPerDay: 5, maxConsecutiveLosses: 3,
  maxPositionSize: null as number | null,
  minRewardRiskRatio: 1.5,
  cooldownAfterLossMinutes: 30, cooldownAfterMaxLossMinutes: 1440,
  blockAfterDailyLossHit: true, blockAfterConsecutiveLosses: true,
  requireStopLoss: true, requireTakeProfit: false,
  requirePlaybook: true, requirePreTradeChecklist: true, requireJournalReason: true,
  allowOverrideInPaperMode: true,
  liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
} as const;

/** Rule-13 activity from the journal; `excludeId` drops the trade being opened. */
export function journalActivity(trades: readonly PaperTrade[], now = new Date(), excludeId?: number): TradingActivity {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const rows = trades.filter((t) => t.id !== excludeId);
  const closes = rows.filter((t) => t.status === "closed" && t.closedAt)
    .map((t) => ({ closedAt: t.closedAt!, pnl: t.pnl ?? 0 }));
  const openedToday = rows.filter((t) => t.status === "open" && (t.openedAt ?? t.createdAt) >= day).length;
  return summarizeActivity(closes, openedToday, now, "paper_trades");
}

export type AggregatedHistory = {
  openTradesCount: number;
  tradesToday: number;
  todayPnl: number;
  weekPnl: number;
  consecutiveLosses: number;
  lastClosedAt: Date | null;
  lastClosedWasLoss: boolean;
  recentClosesInLastHour: number;
  reentriesAfterLossInLastHour: number;
};

/** Journal summary for the status screens: the governor's activity plus open count and today's P/L. */
export function aggregateHistory(trades: readonly PaperTrade[], now = new Date()): AggregatedHistory {
  const a = journalActivity(trades, now);
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const todayPnl = trades.filter((t) => t.status === "closed" && t.closedAt && t.closedAt >= day)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);
  return {
    openTradesCount: trades.filter((t) => t.status === "open").length,
    tradesToday: a.tradesToday,
    todayPnl,
    weekPnl: a.weekRealizedPnl,
    consecutiveLosses: a.consecutiveLosses,
    lastClosedAt: a.lastClosedAt,
    lastClosedWasLoss: a.lastClosedWasLoss,
    recentClosesInLastHour: a.closesInLastHour,
    reentriesAfterLossInLastHour: a.reentriesAfterLossInLastHour,
  };
}
