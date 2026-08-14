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

import {
  db,
  tradePlansTable,
  riskLocksTable,
  brokerHealthStateTable,
  livePositionsTable,
  weeklyPerformanceReviewsTable,
  riskSettingsTable,
  tradesTable,
  performanceDailyTable,
} from "@workspace/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { createAlert } from "./alertManager.js";

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
  const rows = await db.select().from(brokerHealthStateTable).limit(1);
  const s = rows[0];
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
  const rows = await db.select().from(brokerHealthStateTable).limit(1);
  const s = rows[0];
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
    .where(and(eq(tradePlansTable.marketCondition, "NO_TRADE"), eq(tradePlansTable.status, "DRAFT")))
    .limit(20);
  if (plans.length === 0) return { fired: false };
  let any = false;
  for (const p of plans) {
    const r = await createAlert({
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
  const open = await db.select().from(livePositionsTable)
    .where(and(eq(livePositionsTable.status, "OPEN"), isNull(livePositionsTable.closedAt)))
    .limit(50);
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
      const r = await createAlert({
        type: "POSITION_WARNING",
        priority: pctOfSlRemaining <= 0.05 ? "CRITICAL" : "HIGH",
        severity: pctOfSlRemaining <= 0.05 ? "danger" : "warning",
        title: `Position near stop loss: ${p.symbol}`,
        message: `Live position #${p.id} (${p.direction} ${p.symbol}) is ${(pctOfSlRemaining * 100).toFixed(0)}% from stop loss.`,
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
    .where(and(eq(tradePlansTable.status, "INVALIDATED"), gte(tradePlansTable.updatedAt, since)))
    .limit(10);
  if (plans.length === 0) return { fired: false };
  let any = false;
  for (const p of plans) {
    const r = await createAlert({
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
    .where(eq(riskLocksTable.isActive, true))
    .orderBy(desc(riskLocksTable.startTime))
    .limit(10);
  if (locks.length === 0) return { fired: false };
  let any = false;
  for (const l of locks) {
    const r = await createAlert({
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
  // Most-recent review created in the last 24h.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db.select().from(weeklyPerformanceReviewsTable)
    .where(gte(weeklyPerformanceReviewsTable.weekEnd, since))
    .orderBy(desc(weeklyPerformanceReviewsTable.weekEnd))
    .limit(1);
  const r = rows[0];
  if (!r) return { fired: false };
  const out = await createAlert({
    type: "WEEKLY_REVIEW",
    priority: "LOW",
    severity: "info",
    title: "Weekly performance review ready",
    message: `Your review for week ending ${new Date(r.weekEnd).toISOString().slice(0, 10)} is available — ${r.totalTrades} trades, win rate ${(r.winRate * 100).toFixed(0)}%.`,
    dedupeKey: `weekly-review:${r.id}`,
  });
  return { fired: out.id !== 0 };
}

async function nearDailyLossLimitRule() {
  // Compose: read riskSettings.maxDailyLossPct + most recent
  // performance_daily row, alert when realized loss is ≥ 80% of limit.
  const rs = await db.select().from(riskSettingsTable).limit(1);
  const settings = rs[0];
  if (!settings) return { fired: false, reason: "no risk_settings" };

  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10);
  const rows = await db.select().from(performanceDailyTable)
    .where(eq(performanceDailyTable.date, dayKey))
    .limit(1);
  const day = rows[0];
  if (!day || !day.pnl || day.pnl >= 0) return { fired: false };

  // Equity baseline for the max-loss budget. We use the recorded endBalance
  // as the basis; we never fabricate a placeholder capital figure. Without a
  // real end-balance baseline we cannot compute a trustworthy budget, so we
  // do not fire a budget-based alert rather than triggering off fake capital.
  const equity = day.endBalance && day.endBalance > 0 ? day.endBalance : null;
  if (equity == null) return { fired: false, reason: "no equity baseline" };
  const lossLimit = (settings.maxDailyLossPct / 100) * equity;
  const lossSoFar = Math.abs(day.pnl);
  if (lossSoFar >= 0.8 * lossLimit) {
    const out = await createAlert({
      type: "RISK_LOCK",
      priority: lossSoFar >= lossLimit ? "CRITICAL" : "HIGH",
      severity: lossSoFar >= lossLimit ? "danger" : "warning",
      title: lossSoFar >= lossLimit ? "Daily loss limit reached" : "Approaching daily loss limit",
      message: `Today's realized loss is ${lossSoFar.toFixed(2)} of the ${lossLimit.toFixed(2)} max-loss budget. Trading caution advised.`,
      actionRequired: lossSoFar >= lossLimit,
      dedupeKey: `daily-loss:${dayKey}:${Math.floor((lossSoFar / lossLimit) * 10)}`,
    });
    return { fired: out.id !== 0 };
  }
  return { fired: false };
}

void tradesTable;
