import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, userSlotAllocationTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetPerformanceSummaryResponse,
  GetDailyPerformanceQueryParams,
  GetDailyPerformanceResponse,
  GetStrategyBreakdownResponse,
} from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import {
  resolveTradeScope,
  inScope,
  countClosedOutOfScope,
} from "../lib/performance/tradeScope.js";

const router = Router();

// Honest equity baseline for the legacy `trades` performance views. The
// equity curve and drawdown math need a starting-capital anchor; we never
// fabricate an account size. Anchor to the operator-assigned capital in
// `user_slot_allocation` when present (> 0). Only when a user has legacy
// trades but no assigned capital do we fall back to a clearly-named notional
// baseline, used purely for the relative curve/drawdown shape — it is never
// presented as the user's real broker balance (that is sourced separately
// from the live/shared account on the analytics page).
const LEGACY_NOTIONAL_BASELINE = 10000;

export type EquityBaselineSource = "ASSIGNED" | "NOTIONAL" | "NONE";
export interface EquityBaseline {
  value: number;
  source: EquityBaselineSource;
}

// The chosen anchor is returned WITH its provenance. A NOTIONAL anchor is a
// shape device, not the user's money: every consumer must be able to tell the
// difference, and the client is required to label a curve built on it. The
// previous signature returned a bare number, so `$10,000.00` reached the
// "Starting Equity" tile with nothing marking it as invented.
async function resolveEquityBaseline(userId: number, hasLegacyTrades: boolean): Promise<EquityBaseline> {
  const rows = await db
    .select({ allocated: userSlotAllocationTable.allocatedFunds })
    .from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId))
    .limit(1);
  const allocated = rows[0]?.allocated;
  if (typeof allocated === "number" && allocated > 0) return { value: allocated, source: "ASSIGNED" };
  // No operator-assigned capital. Only fall back to the notional baseline when
  // there are real legacy closed trades that need a curve anchor; with neither
  // real capital nor trades there is nothing to anchor, so report 0 rather
  // than fabricating a $10k account balance.
  return hasLegacyTrades
    ? { value: LEGACY_NOTIONAL_BASELINE, source: "NOTIONAL" }
    : { value: 0, source: "NONE" };
}

// GET /performance/summary
router.get("/performance/summary", requireUser, async (req, res) => {
  try {
    const allTrades = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, req.authUser!.id));

    // Environment scoping — real broker money and simulator money are never
    // summed into one figure. Every number below belongs to exactly one
    // environment, and the client is told which.
    const scope = resolveTradeScope(allTrades);
    const otherModeTradeCount = countClosedOutOfScope(allTrades, scope.mode);
    const trades = inScope(allTrades, scope.mode);

    const openTrades = trades.filter((t) => t.status === "OPEN");
    // Phase: PNL_UNKNOWN propagation — any closed row whose realised P/L
    // could not be trusted (pnlStatus="UNKNOWN") is excluded from every
    // aggregate below. We never fabricate a value here. See
    // artifacts/api-server/src/lib/live/realizedPnl.ts for the contract.
    const allClosedTrades = trades.filter((t) => t.status !== "OPEN" && t.status !== "CANCELLED");
    const excludedUnknown = allClosedTrades.filter((t) => t.pnlStatus === "UNKNOWN");
    const closedTrades = allClosedTrades.filter((t) => t.pnlStatus !== "UNKNOWN");
    const wins = closedTrades.filter((t) => t.status === "CLOSED_WIN");
    const losses = closedTrades.filter((t) => t.status === "CLOSED_LOSS");
    const totalPnl = closedTrades.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
    const pnlValues = closedTrades.map((t) => t.pnl ?? 0);
    const bestTradePnl = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
    const worstTradePnl = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;
    const grossProfit = wins.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.pnl ?? 0), 0));
    // SENTINEL, not a measurement: with zero gross loss the ratio is
    // undefined. The response contract types `profitFactor` as a plain
    // number (GetPerformanceSummaryResponse), so null cannot be sent from
    // here — 9.99 is the legacy stand-in. Clients MUST NOT render it as a
    // measured ratio: read `losingTrades === 0` and say "no losses yet"
    // instead (see trading-dashboard/src/pages/analytics.tsx
    // profitFactorText).
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0;
    const avgConfidence = trades.length > 0 ? trades.reduce((a, t) => a + t.confidence, 0) / trades.length : 0;

    // ── TODAY ────────────────────────────────────────────────────────────
    // Every field above this line is ALL-TIME. A card titled "Today's
    // Performance" previously read totalTrades/winningTrades/winRate/
    // bestTradePnl straight off those lifetime fields, so a lifetime 62% win
    // rate rendered as if it happened today. The today-scoped block below is
    // the only honest source for a day-scoped surface.
    const today = new Date().toISOString().slice(0, 10);
    const isToday = (t: { closedAt: Date | null }) =>
      !!t.closedAt && t.closedAt.toISOString().slice(0, 10) === today;
    const todayTrades = closedTrades.filter(isToday);
    const todayPnl = todayTrades.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const todayWins = todayTrades.filter((t) => t.status === "CLOSED_WIN");
    const todayLosses = todayTrades.filter((t) => t.status === "CLOSED_LOSS");
    const todayPnlValues = todayTrades.map((t) => t.pnl ?? 0);
    const todayBlock = {
      trades: todayTrades.length,
      wins: todayWins.length,
      losses: todayLosses.length,
      winRate: todayTrades.length > 0 ? (todayWins.length / todayTrades.length) * 100 : 0,
      pnl: todayPnl,
      // null, not 0 — "no trade closed today" is not "the best trade was $0".
      bestTradePnl: todayPnlValues.length > 0 ? Math.max(...todayPnlValues) : null,
      worstTradePnl: todayPnlValues.length > 0 ? Math.min(...todayPnlValues) : null,
      excludedUnknownCount: excludedUnknown.filter(isToday).length,
    };

    // Max drawdown (simplified). Anchor to the user's real assigned capital,
    // never a fabricated account size. `baselineSource` travels with the
    // number so the client can label a notional anchor.
    const { value: baseline, source: baselineSource } =
      await resolveEquityBaseline(req.authUser!.id, closedTrades.length > 0);
    let peak = baseline;
    let maxDD = 0;
    let balance = baseline;
    for (const t of closedTrades) {
      balance += t.pnl ?? 0;
      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    const accountBalance = baseline + totalPnl;

    const data = GetPerformanceSummaryResponse.parse({
      accountBalance,
      todayPnl,
      todayPnlPct: accountBalance > 0 ? (todayPnl / accountBalance) * 100 : 0,
      totalPnl,
      winRate,
      maxDrawdown: maxDD,
      totalTrades: closedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      openTrades: openTrades.length,
      bestTradePnl,
      worstTradePnl,
      profitFactor,
      avgConfidence,
      excludedUnknownCount: excludedUnknown.length,
      scopeMode: scope.mode,
      scopeModeReason: scope.reason,
      otherModeTradeCount,
      baselineSource,
      baselineValue: baseline,
      today: todayBlock,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get performance summary" });
  }
});

// GET /performance/daily
//
// Daily P/L + equity curve. Computed on-the-fly from `tradesTable` so the
// pnlStatus="UNKNOWN" exclusion rule is honoured here too — `performance_daily`
// is a precomputed cache and predates the pnlStatus contract, so any row
// whose realised P/L could not be trusted would silently pollute it. We
// keep `performance_daily` as the historical end-balance anchor (seed) and
// rebuild today's view from trades, never including UNKNOWN rows.
router.get("/performance/daily", requireUser, async (req, res) => {
  try {
    const params = GetDailyPerformanceQueryParams.parse({
      days: req.query["days"] ? Number(req.query["days"]) : 30,
    });
    const userId = req.authUser!.id;
    const days = params.days ?? 30;

    // Pull all CLOSED trades (any time) for this user; the cumulative
    // equity curve has to walk from the assigned-capital baseline forward to
    // get a stable endBalance for each day even when we only return the last
    // `days`.
    const everyTrade = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(tradesTable.closedAt);

    // Same deterministic environment scope as /performance/summary — the
    // equity curve must not walk a balance that adds broker money to
    // simulator money. GET /performance/summary reports `scopeMode`, which
    // labels this series on the client.
    const scope = resolveTradeScope(everyTrade);
    const allClosed = inScope(everyTrade, scope.mode);

    // Honest starting capital — operator-assigned funds, never a fabricated
    // account size (see resolveEquityBaseline).
    const { value: STARTING_BALANCE } = await resolveEquityBaseline(userId, allClosed.length > 0);
    // Bucket trusted closes by yyyy-mm-dd. UNKNOWN rows
    // (isRealizedPnlIngestible === false) are skipped.
    const buckets = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();
    for (const t of allClosed) {
      if (!t.closedAt) continue;
      if (t.status === "OPEN" || t.status === "CANCELLED") continue;
      // Skip rows whose realised P/L is untrusted. `tradesTable` stores
      // P/L in `pnl` (not `realizedPlUsd`), so we use a trade-row-shaped
      // predicate: legacy null pnlStatus rows with a finite pnl are
      // treated as implicitly trusted (back-compat with historical data),
      // while any row explicitly tagged "UNKNOWN" is excluded.
      if (t.pnlStatus === "UNKNOWN") continue;
      if (typeof t.pnl !== "number" || !Number.isFinite(t.pnl)) continue;
      const dayKey = t.closedAt.toISOString().slice(0, 10);
      const bucket = buckets.get(dayKey) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
      bucket.pnl += t.pnl ?? 0;
      bucket.trades += 1;
      if (t.status === "CLOSED_WIN") bucket.wins += 1;
      else if (t.status === "CLOSED_LOSS") bucket.losses += 1;
      buckets.set(dayKey, bucket);
    }

    // Walk every bucket in ascending date order to derive endBalance, then
    // return the most recent `days` entries newest-first (matches the
    // previous response shape, which was `desc(date)` + limit).
    const orderedKeys = [...buckets.keys()].sort();
    const cumulative: Array<{ date: string; pnl: number; trades: number; wins: number; losses: number; winRate: number; endBalance: number; id: number }> = [];
    let running = STARTING_BALANCE;
    let syntheticId = 0;
    for (const k of orderedKeys) {
      const b = buckets.get(k)!;
      running += b.pnl;
      cumulative.push({
        id: ++syntheticId,
        date: k,
        pnl: b.pnl,
        trades: b.trades,
        wins: b.wins,
        losses: b.losses,
        winRate: b.trades > 0 ? (b.wins / b.trades) * 100 : 0,
        endBalance: running,
      });
    }
    const sliced = cumulative.slice(-days).reverse();
    const data = GetDailyPerformanceResponse.parse(sliced);
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get daily performance" });
  }
});

// GET /performance/strategy-breakdown
router.get("/performance/strategy-breakdown", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    // Scope has to be resolved over the user's WHOLE trade set (an open LIVE
    // position still makes the account LIVE), so read everything and filter
    // in memory rather than pushing the status predicate into SQL.
    const everyTrade = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId));
    const scope = resolveTradeScope(everyTrade);
    const trades = inScope(everyTrade, scope.mode)
      .filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");

    const grouped: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const t of trades) {
      // Skip rows whose realised P/L is untrusted — never let them
      // pollute a strategy win/loss or P/L total.
      if (t.pnlStatus === "UNKNOWN") continue;
      if (!grouped[t.strategy]) grouped[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
      if (t.status === "CLOSED_WIN") grouped[t.strategy].wins++;
      if (t.status === "CLOSED_LOSS") grouped[t.strategy].losses++;
      grouped[t.strategy].pnl += t.pnl ?? 0;
    }

    const breakdown = Object.entries(grouped).map(([strategy, stats]) => {
      const total = stats.wins + stats.losses;
      return {
        strategy,
        totalTrades: total,
        wins: stats.wins,
        losses: stats.losses,
        winRate: total > 0 ? (stats.wins / total) * 100 : 0,
        totalPnl: stats.pnl,
      };
    });

    const data = GetStrategyBreakdownResponse.parse(breakdown);
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get strategy breakdown" });
  }
});

export default router;
