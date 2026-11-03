// (L) Build L — Smart Alert rule engine.
//
// Pure compose: scans current state from existing tables (trade_plans,
// risk_locks, broker_health_state, live_positions, weekly_performance_reviews,
// risk_settings, trades) and emits alerts via createAlert(). All dedupe and
// preferences gating happens inside createAlert(); this engine just decides
// what *should* exist right now and fires non-duplicate creations.
//
// Inviolable: no rule may claim guaranteed profit. Messages describe the
// observed condition only.
//
// Ownership: an alert with no userId is shown to every user (alertManager
// visibleTo), so only platform-wide conditions (broker link, price feed) are
// raised that way. Every rule over a trader's own rows attributes the alert
// to that row's owner and skips ownerless legacy rows, which would otherwise
// be broadcast.

import { demoPositionColumns } from "../positions/ledger.js";
import { ALERT_ELIGIBLE_BASIS, selectDemoOpenPositionsForAllUsers } from "../positions/openPositions.js";
import {
  db,
  tradePlansTable,
  riskLocksTable,
  weeklyPerformanceReviewsTable,
  tradesTable,
  performanceDailyTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { createAlert } from "./alertManager.js";
import { readBrokerHealthState } from "../brokerHub/brokerHealthState.js";
import { loadEffectiveLimitsMany } from "../riskGovernor/limitSettings.js";
import { dailyLossCapAmount } from "../riskGovernor/preTrade.js";

export interface RuleResult {
  evaluated: number;
  fired: number;
  details: Array<{ rule: string; fired: boolean; reason?: string }>;
}

export async function evaluateAndGenerate(): Promise<RuleResult> {
  const details: RuleResult["details"] = [];
  let fired = 0;
  const fire = async (rule: string, fn: () => Promise<{ fired: boolean; reason?: string }>) => {
    try {
      const r = await fn();
      details.push({ rule, ...r });
      if (r.fired) fired++;
    } catch (err) {
      details.push({ rule, fired: false, reason: `error: ${(err as Error).message}` });
    }
  };

  await fire("BROKER_DISCONNECTED", brokerDisconnectedRule);
  await fire("PRICE_FEED_DELAYED", priceFeedDelayedRule);
  await fire("MARKET_NO_TRADE", marketNoTradeRule);
  await fire("POSITION_NEAR_STOP_LOSS", positionNearStopLossRule);
  await fire("TRADE_PLAN_INVALID", tradePlanInvalidRule);
  await fire("RISK_LOCK_ACTIVE", riskLockActiveRule);
  await fire("WEEKLY_REVIEW_READY", weeklyReviewReadyRule);
  await fire("NEAR_DAILY_LOSS_LIMIT", nearDailyLossLimitRule);

  return { evaluated: details.length, fired, details };
}

// ── Broker / market rules ────────────────────────────────────────────────

async function brokerDisconnectedRule() {
  const s = await readBrokerHealthState();
  if (!s) return { fired: false, reason: "no broker_health_state row" };
  const status = s.lastStatus ?? "UNKNOWN";
  if (status === "DISCONNECTED" || status === "DOWN" || s.executionEnabled === false) {
    await createAlert({
      type: "BROKER_HEALTH",
      priority: status === "DISCONNECTED" || status === "DOWN" ? "CRITICAL" : "HIGH",
      severity: "danger",
      title: "Broker connection issue",
      message: `Broker reports status ${status}. Execution is gated until the connection recovers. ${s.lastErrorMessage ?? ""}`.trim(),
      actionRequired: true,
      dedupeKey: `broker:${status}`,
    });
    return { fired: true };
  }
  return { fired: false, reason: `status=${status}` };
}

async function priceFeedDelayedRule() {
  // Delay signal lives in broker_health_logs.priceFeedDelayMs — read latest log.
  const s = await readBrokerHealthState();
  if (!s) return { fired: false, reason: "no state" };
  // We treat reconnectAttempts > 0 with a degraded status as a feed delay proxy.
  const status = s.lastStatus ?? "UNKNOWN";
  if ((status === "DEGRADED" || status === "STALE") && s.reconnectAttempts >= 1) {
    await createAlert({
      type: "BROKER_HEALTH",
      priority: "HIGH",
      severity: "warning",
      title: "Price feed delayed",
      message: `Broker is ${status} after ${s.reconnectAttempts} reconnect attempt(s). Trade execution may be delayed.`,
      dedupeKey: `feed-delay:${status}:${s.reconnectAttempts}`,
    });
    return { fired: true };
  }
  return { fired: false };
}

async function marketNoTradeRule() {
  // Any active trade plan currently in NO_TRADE market condition → coach the
  // trader. We only emit one per symbol per dedupe window.
  const plans = await db.select().from(tradePlansTable)
    .where(and(eq(tradePlansTable.marketCondition, "NO_TRADE"), eq(tradePlansTable.status, "DRAFT"), isNotNull(tradePlansTable.userId)))
    .limit(20);
  if (plans.length === 0) return { fired: false };
  let any = false;
  for (const p of plans) {
    const r = await createAlert({
      userId: p.userId,
      type: "MARKET_CONDITION",
      priority: "MEDIUM",
      severity: "warning",
      title: `Market condition: NO TRADE (${p.symbol ?? "—"})`,
      message: `Active plan #${p.id} is operating in a NO_TRADE market. Consider postponing entry until conditions improve.`,
      symbol: p.symbol ?? undefined,
      relatedTradePlanId: p.id,
      dedupeKey: `market-no-trade:${p.id}`,
    });
    if (r.id !== 0) any = true;
  }
  return { fired: any };
}

// ── Position rules ───────────────────────────────────────────────────────

async function positionNearStopLossRule() {
  // Open positions whose current price is within 25% of the SL distance.
  // ALERT_ELIGIBLE (owner decision 11): status OPEN, closed_at not stamped and
  // an owner on the row; ownerless and closed rows never raise a trader alert.
  const open = await selectDemoOpenPositionsForAllUsers(demoPositionColumns, {
    basis: ALERT_ELIGIBLE_BASIS.DEMO,
    limit: 50,
  });
  let any = false;
  for (const p of open) {
    if (p.stopLoss == null || p.currentPrice == null) continue;
    const slDist = Math.abs(p.entryPrice - p.stopLoss);
    if (slDist === 0) continue;
    const remaining = p.direction === "BUY"
      ? Math.max(0, p.currentPrice - p.stopLoss)
      : Math.max(0, p.stopLoss - p.currentPrice);
    const pctOfSlRemaining = remaining / slDist;
    if (pctOfSlRemaining <= 0.25) {
      // live_positions is the DEMO / legacy EA mirror, never the LIVE venue
      // (arx_live_positions): say so, and say which price the distance was
      // measured from and when that row was last synced.
      const syncedMs = p.lastSyncedAt ? new Date(p.lastSyncedAt).getTime() : NaN;
      const asOf = Number.isFinite(syncedMs)
        ? `, last synced ${new Date(syncedMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
        : " (sync time not recorded)";
      const r = await createAlert({
        userId: p.userId,
        type: "POSITION_WARNING",
        priority: pctOfSlRemaining <= 0.05 ? "CRITICAL" : "HIGH",
        severity: pctOfSlRemaining <= 0.05 ? "danger" : "warning",
        title: `Demo position near stop loss: ${p.symbol}`,
        message: `Demo position #${p.id} (${p.direction} ${p.symbol}) has ${(pctOfSlRemaining * 100).toFixed(0)}% of its stop-loss distance left at the last recorded price ${p.currentPrice}${asOf}.`,
        symbol: p.symbol,
        relatedPositionId: p.id,
        relatedTradeId: p.tradeId ?? undefined,
        actionRequired: pctOfSlRemaining <= 0.05,
        // Bucket dedupe by 5-percent band so we don't realert continuously.
        dedupeKey: `pos-near-sl:${p.id}:${Math.floor(pctOfSlRemaining * 20)}`,
      });
      if (r.id !== 0) any = true;
    }
  }
  return { fired: any };
}

// ── Trade plan / risk lock / coach ───────────────────────────────────────

async function tradePlanInvalidRule() {
  // Plans newly INVALIDATED in the last 5 min.
  const since = new Date(Date.now() - 5 * 60 * 1000);
  const plans = await db.select().from(tradePlansTable)
    .where(and(eq(tradePlansTable.status, "INVALIDATED"), gte(tradePlansTable.updatedAt, since), isNotNull(tradePlansTable.userId)))
    .limit(10);
  if (plans.length === 0) return { fired: false };
  let any = false;
  for (const p of plans) {
    const r = await createAlert({
      userId: p.userId,
      type: "TRADE_PLAN_INVALIDATED",
      priority: "MEDIUM",
      severity: "warning",
      title: `Trade plan invalidated: ${p.symbol ?? `#${p.id}`}`,
      message: `Plan #${p.id} no longer passes the readiness checklist. ${p.aiSummary ?? ""}`.trim(),
      symbol: p.symbol ?? undefined,
      relatedTradePlanId: p.id,
      // Same plan won't realert until updatedAt changes (different dedupeKey).
      dedupeKey: `plan-invalid:${p.id}:${p.updatedAt.getTime()}`,
    });
    if (r.id !== 0) any = true;
  }
  return { fired: any };
}

async function riskLockActiveRule() {
  const locks = await db.select().from(riskLocksTable)
    .where(and(eq(riskLocksTable.isActive, true), isNotNull(riskLocksTable.userId)))
    .orderBy(desc(riskLocksTable.startTime))
    .limit(10);
  if (locks.length === 0) return { fired: false };
  let any = false;
  for (const l of locks) {
    const r = await createAlert({
      userId: l.userId,
      type: "RISK_LOCK",
      priority: "HIGH",
      severity: "danger",
      title: `Risk lock active: ${l.lockType}`,
      message: `Trading is paused — ${l.reason}`,
      actionRequired: false,
      dedupeKey: `risk-lock:${l.id}`,
    });
    if (r.id !== 0) any = true;
  }
  return { fired: any };
}

async function weeklyReviewReadyRule() {
  // Each trader's reviews that closed in the last 24h; the alert goes to the
  // review's owner only.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db.select().from(weeklyPerformanceReviewsTable)
    .where(and(gte(weeklyPerformanceReviewsTable.weekEnd, since), isNotNull(weeklyPerformanceReviewsTable.userId)))
    .orderBy(desc(weeklyPerformanceReviewsTable.weekEnd))
    .limit(50);
  let any = false;
  for (const r of rows) {
    const out = await createAlert({
      userId: r.userId,
      type: "WEEKLY_REVIEW",
      priority: "LOW",
      severity: "info",
      title: "Weekly performance review ready",
      message: `Your review for week ending ${new Date(r.weekEnd).toISOString().slice(0, 10)} is available — ${r.totalTrades} trades, win rate ${(r.winRate * 100).toFixed(0)}%.`,
      dedupeKey: `weekly-review:${r.id}`,
    });
    if (out.id !== 0) any = true;
  }
  return { fired: any };
}

async function nearDailyLossLimitRule() {
  // Per trader: today's performance_daily row against the daily-loss cap the
  // Risk Governor enforces for that trader (owner decision 8:
  // loadEffectiveLimits, so the operator's USD cap and the trader's off
  // switch count); alert at >= 80%. It used to also take the first
  // risk_settings row as a "platform" figure, which was whichever trader's
  // row came back first.

  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10);
  const days = await db.select().from(performanceDailyTable)
    .where(and(eq(performanceDailyTable.date, dayKey), isNotNull(performanceDailyTable.userId)))
    .limit(200);
  const losing = days.filter((d) => d.pnl != null && d.pnl < 0);
  if (losing.length === 0) return { fired: false };

  const userIds = [...new Set(losing.map((d) => d.userId!))];
  const limits = await loadEffectiveLimitsMany(userIds);

  let any = false;
  for (const day of losing) {
    const L = limits.get(day.userId!);
    if (!L) continue;
    // Equity baseline for a percent cap. We use the recorded endBalance as
    // the basis; we never fabricate a placeholder capital figure. Without a
    // real end-balance baseline only an amount cap can be checked; with
    // neither there is no trustworthy budget and no alert fires.
    const equity = day.endBalance && day.endBalance > 0 ? day.endBalance : null;
    const lossLimit = dailyLossCapAmount(L, equity);
    if (lossLimit == null) continue;
    const lossSoFar = Math.abs(day.pnl!);
    if (lossSoFar < 0.8 * lossLimit) continue;
    const out = await createAlert({
      userId: day.userId,
      type: "RISK_LOCK",
      priority: lossSoFar >= lossLimit ? "CRITICAL" : "HIGH",
      severity: lossSoFar >= lossLimit ? "danger" : "warning",
      title: lossSoFar >= lossLimit ? "Daily loss limit reached" : "Approaching daily loss limit",
      message: `Today's realized loss is ${lossSoFar.toFixed(2)} of the ${lossLimit.toFixed(2)} max-loss budget. Trading caution advised.`,
      actionRequired: lossSoFar >= lossLimit,
      dedupeKey: `daily-loss:${dayKey}:${Math.floor((lossSoFar / lossLimit) * 10)}`,
    });
    if (out.id !== 0) any = true;
  }
  return { fired: any };
}

void tradesTable;
