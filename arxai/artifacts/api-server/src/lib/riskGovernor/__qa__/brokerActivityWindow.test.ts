// Risk Governor (DEMO and LIVE) — round-3 safety review, group s3-governor:
// rule 13's weekly loss cap and today's trade count cover every close in
// their window, not only the newest 50.
//
// The governor reads the trading activity of a DEMO account from the trades
// journal and of a LIVE account from the live ledger (arx_live_positions).
// The losing streak, the cooldown and the last-hour checks read the newest 50
// closes. The week's P/L and today's trade count were summed from those 50
// rows too, so an account whose EA or automation closed more than 50 trades
// in a week (or a day) dropped its older closes: ten −100 losses followed by
// 50 closes that net 0 read a week of 0, and a $500 weekly cap passed on a
// −1,000 week. They are now read with an unbounded SUM and COUNT over the
// same ledger. The week's P/L counted is the lower of the whole week's and
// the newest closes' within the week, so the weekly cap never reads less
// loss than it read before; the refusal names both when they differ.
//
// Needs a real PostgreSQL (DATABASE_URL); the REAL fact loader and the REAL
// pure evaluator run. Rows are written for a test-only user id and removed.
// Run: pnpm --filter @workspace/api-server run test:risk-governor-broker-activity (needs PostgreSQL), or
// node --import tsx --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/brokerActivityWindow.test.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, tradesTable, arxLivePositionsTable } from "@workspace/db";
import { loadTradingActivity } from "../enforce.js";
import { evaluatePreTradeRisk, resolveEffectiveLimits, type RiskContext, type TradeIntent, type TradingActivity } from "../preTrade.js";

const USER = 880_731;
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function clear(): Promise<void> {
  await db.delete(tradesTable).where(eq(tradesTable.userId, USER));
  await db.delete(arxLivePositionsTable).where(eq(arxLivePositionsTable.userId, USER));
}
before(clear);
after(clear);

/** Seed DEMO closes (trades journal) and LIVE closes (live ledger), one per {pnl, closedAt}. */
async function seed(closes: Array<{ pnl: number; closedAt: Date }>): Promise<void> {
  await clear();
  await db.insert(tradesTable).values(closes.map((c) => ({
    userId: USER, symbol: "EURUSD", direction: "BUY", lot: 0.1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    strategy: "qa", confidence: 50, status: c.pnl < 0 ? "CLOSED_LOSS" : "CLOSED_WIN", mode: "DEMO", pnl: c.pnl, closedAt: c.closedAt,
  })));
  await db.insert(arxLivePositionsTable).values(closes.map((c, i) => ({
    userId: USER, bridgeConnectionId: 1, brokerTicket: `qa-${i}`, symbol: "EURUSD", side: "BUY", volume: 0.1,
    entryPrice: 1.1, floatingPl: c.pnl, openedAt: new Date(c.closedAt.getTime() - 600_000), closedAt: c.closedAt,
  })));
}

// Only the cap under test is set: the default trades-per-day, losing-streak
// and cooldown caps are cleared so the refusal leads with it.
const QUIET_CTX = (activity: TradingActivity, discipline: Partial<RiskContext["limits"]["discipline"]>): RiskContext => {
  const base = resolveEffectiveLimits({});
  return {
    now: NOW,
    limits: { ...base, discipline: {
      ...base.discipline, maxTradesPerDay: null, maxConsecutiveLosses: null, cooldownAfterLossMinutes: null,
      maxWeeklyLossAmount: null, maxWeeklyLossPercent: null, ...discipline,
    } },
    account: { equity: 10_000, freeMargin: 9_000, leverage: 100, currency: "USD", source: "test" },
    instruments: { EURUSD: { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "FX_STANDARD_LOT" } },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 2_000), source: "test" },
    positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: NOW, detail: "test" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    activity,
  };
};
const intent = (venue: "DEMO" | "LIVE"): TradeIntent => ({
  userId: USER, venue, origin: "manual", action: "OPEN", symbol: "EURUSD", side: "BUY", lots: 0.1,
  stopLoss: 1.0951, takeProfit: 1.1101,
});
const discipline = (venue: "DEMO" | "LIVE", activity: TradingActivity, limits: Partial<RiskContext["limits"]["discipline"]>) =>
  evaluatePreTradeRisk(intent(venue), QUIET_CTX(activity, limits)).rules.find((r) => r.rule === "trading_discipline")!;

test("the weekly loss cap reads every close of the last 7 days on DEMO and LIVE: ten older −100 losses and 50 newer closes that net 0 read −1,000, not 0", async () => {
  // Oldest first: ten −100 losses six days ago, then 50 closes over the last
  // four days alternating −100 / +100 (net 0), the newest a win.
  await seed([
    ...Array.from({ length: 10 }, (_v, i) => ({ pnl: -100, closedAt: hoursAgo(6 * 24 - i) })),
    ...Array.from({ length: 50 }, (_v, i) => ({ pnl: i % 2 ? 100 : -100, closedAt: hoursAgo(1 + 2 * (49 - i)) })),
  ]);
  for (const venue of ["DEMO", "LIVE"] as const) {
    const act = await loadTradingActivity(USER, venue, { now: NOW });
    assert.ok(act, `${venue}: activity could not be read`);
    assert.equal(act.weekRealizedPnl, -1_000, `${venue}: the week's P/L read only the newest 50 closes (${act.weekRealizedPnl})`);
    assert.equal(act.allWeekRealizedPnl, undefined, `${venue}: the whole week is the figure counted`);
    assert.equal(act.consecutiveLosses, 0, `${venue}: the losing streak still reads the newest closes`);
    assert.equal(act.lastClosedWasLoss, false);
    const r = discipline(venue, act, { maxWeeklyLossAmount: 500 });
    assert.equal(r.outcome, "BLOCK", `${venue}: a $500 weekly cap passed on a −1,000 week`);
    assert.match(r.reason!, /this week's loss 1000 reached your weekly cap of 500/);
  }
});

test("today's trade count covers every close today on DEMO and LIVE, not only the newest 50", async () => {
  const dayStart = new Date(NOW); dayStart.setUTCHours(0, 0, 0, 0);
  const span = NOW.getTime() - dayStart.getTime();
  await seed(Array.from({ length: 70 }, (_v, i) => ({ pnl: i % 2 ? -1 : 1, closedAt: new Date(dayStart.getTime() + (span * (i + 1)) / 71) })));
  for (const venue of ["DEMO", "LIVE"] as const) {
    const act = await loadTradingActivity(USER, venue, { now: NOW });
    assert.ok(act);
    assert.equal(act.tradesToday, 70, `${venue}: today's trades read only the newest 50 closes (${act.tradesToday})`);
    const r = discipline(venue, act, { maxTradesPerDay: 60 });
    assert.equal(r.outcome, "BLOCK", `${venue}: a 60-trade day cap passed on 70 closes today`);
    assert.match(r.reason!, /you have reached your 60 trades for today/);
  }
});

test("never less loss than before: when the newest 50 closes lost more than the whole week, the weekly cap counts the newest closes and the refusal names both", async () => {
  // Ten +100 wins six days ago, then 50 closes over the last four days that
  // net −500 (25 × −120 and 25 × +100). The whole week nets +500; the newest
  // 50 closes, which is what the cap read before, lost 500.
  const newest = Array.from({ length: 50 }, (_v, i) => ({ pnl: i % 2 ? 100 : -120, closedAt: hoursAgo(1 + 2 * (49 - i)) }));
  await seed([
    ...Array.from({ length: 10 }, (_v, i) => ({ pnl: 100, closedAt: hoursAgo(6 * 24 - i) })),
    ...newest,
  ]);
  for (const venue of ["DEMO", "LIVE"] as const) {
    const act = await loadTradingActivity(USER, venue, { now: NOW });
    assert.ok(act);
    assert.equal(act.weekRealizedPnl, -500, `${venue}: the weekly cap read less loss than the newest closes show (${act.weekRealizedPnl})`);
    assert.equal(act.allWeekRealizedPnl, 500);
    assert.deepEqual(act.weekNewestCloses, { counted: 50, since: newest[0]!.closedAt, ofTotal: 60 });
    const r = discipline(venue, act, { maxWeeklyLossAmount: 500 });
    assert.equal(r.outcome, "BLOCK");
    assert.match(r.reason!, new RegExp(`this week's loss 500 \\(counted from your newest 50 of this week's 60 closes, since ${newest[0]!.closedAt.toISOString().replace(/\./g, "\\.")}; all of this week's closes net 500\\) reached your weekly cap of 500`));
    assert.equal(r.measured?.["allWeekRealizedPnl"], 500);
  }
});
