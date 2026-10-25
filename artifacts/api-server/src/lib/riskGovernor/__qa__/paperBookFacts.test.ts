// Owner decision 7: automated PAPER P/L, activity, losing streaks and risk
// decisions read paper_orders through the paper book's read side
// (lib/tradeEngine/paperBookReader.ts). paper_trades stays the trader's
// journal and trades stays legacy history / the DEMO ledger: never mixed in,
// never double counted. Missing coverage stays conservative. DEMO unchanged.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-paper-facts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import {
  db,
  paperAccountsTable,
  paperOrdersTable,
  paperTradesTable,
  tradesTable,
  usersTable,
} from "@workspace/db";
import { buildRiskContext, loadTradingActivity } from "../enforce.js";
import { evaluateReadiness } from "../../readiness/traderReadiness.js";
import { paperLosingStreak } from "../../../routes/tradeDecision.js";
import {
  readPaperCloses,
  realizedOf,
  sumPaperRealizedSince,
  readOpenPaperOrders,
} from "../../tradeEngine/paperBookReader.js";

const P = process.pid;
const u = { alice: 0, bob: 0, switcher: 0 };
const acct = { alice: 0, bob: 0, swOld: 0, swNew: 0 };
const EE = `qa_paper_facts_${P}`;
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

before(async () => {
  for (const k of Object.keys(u) as Array<keyof typeof u>) {
    const [row] = await db.insert(usersTable)
      .values({ email: `qa+paper-facts-${k}-${P}@arx.test`, name: k, role: "USER", isSystemUser: true }).returning();
    u[k] = row!.id;
  }
  const [a] = await db.insert(paperAccountsTable).values({ userId: u.alice, equity: 10_000 }).returning();
  const [b] = await db.insert(paperAccountsTable).values({ userId: u.bob, equity: 10_000 }).returning();
  const [so] = await db.insert(paperAccountsTable).values({ userId: u.switcher, isActive: 0, createdAt: minsAgo(600) }).returning();
  const [sn] = await db.insert(paperAccountsTable).values({ userId: u.switcher, isActive: 1 }).returning();
  acct.alice = a!.id; acct.bob = b!.id; acct.swOld = so!.id; acct.swNew = sn!.id;

  const order = (userId: number | null, paperAccountId: number, o: Partial<typeof paperOrdersTable.$inferInsert>) => ({
    userId, paperAccountId, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, ...o,
  });
  await db.insert(paperOrdersTable).values([
    // alice: one loss closed today, one win yesterday-ish, one open, one voided (no closed_at)
    order(u.alice, acct.alice, { status: "CLOSED_SL", closedAt: minsAgo(5), exitPrice: 1.095, profitLoss: -50 }),
    order(u.alice, acct.alice, { status: "OPEN" }),
    order(u.alice, acct.alice, { status: "CANCELLED" }),
    // bob (another tenant): a big loss today, same symbol
    order(u.bob, acct.bob, { status: "CLOSED_SL", closedAt: minsAgo(3), exitPrice: 1.0, profitLoss: -999 }),
    // switcher: two losses on the old account, nothing yet on the new one
    order(u.switcher, acct.swOld, { status: "CLOSED_SL", closedAt: minsAgo(30), exitPrice: 1.095, profitLoss: -20 }),
    order(u.switcher, acct.swOld, { status: "CLOSED_MANUAL", closedAt: minsAgo(20), exitPrice: 1.098, profitLoss: -10 }),
    // ownerless autopilot rows for the strategy-scoped read
    order(null, acct.alice, { strategyId: EE, status: "CLOSED_TP", closedAt: minsAgo(2), exitPrice: 1.12, profitLoss: 7 }),
  ]);
  // alice's journal (paper_trades) and legacy / DEMO (trades) rows: never paper facts.
  await db.insert(paperTradesTable).values({ userId: u.alice, symbol: "EURUSD", side: "buy", lotSize: 1, status: "closed", pnl: -500, closedAt: minsAgo(4) });
  await db.insert(tradesTable).values({ userId: u.alice, symbol: "EURUSD", direction: "BUY", lot: 1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    strategy: "qa", confidence: 50, status: "CLOSED_LOSS", mode: "DEMO", pnl: -300, closedAt: minsAgo(6) });
});

after(async () => {
  const ids = Object.values(u).filter(Boolean);
  if (!ids.length) return;
  const accts = Object.values(acct).filter(Boolean);
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.paperAccountId, accts));
  await db.delete(paperTradesTable).where(inArray(paperTradesTable.userId, ids));
  await db.delete(tradesTable).where(inArray(tradesTable.userId, ids));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.id, accts));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

const intent = (userId: number, venue: "PAPER" | "DEMO") =>
  ({ userId, venue, origin: "manual" as const, action: "OPEN" as const, symbol: "EURUSD", side: "BUY" as const, lots: 0.01, stopLoss: 1.09 });

test("no double count: the governor's PAPER P/L is paper_orders only (not the journal, not trades)", async () => {
  const ctx = await buildRiskContext(intent(u.alice, "PAPER"), { facts: { quote: null, halt: null } });
  assert.equal(ctx.daily.realizedPnl, -50 + 7, "alice's account: her settled loss plus the ownerless EE row booked on it; journal -500 and trades -300 not added");
  assert.equal(ctx.positions.length, 1, "one open order; the voided order never counts");
  const act = await loadTradingActivity(u.alice, "PAPER");
  assert.equal(act!.source, `paper_orders:account:${acct.alice}`);
  assert.equal(act!.consecutiveLosses, 0, "newest settled order on the account is the +7 win");
});

test("read side: settled / open / realized, per scope", async () => {
  assert.equal(await sumPaperRealizedSince({ user: u.alice }, minsAgo(60)), -50);
  assert.equal(await sumPaperRealizedSince({ owner: null, strategyId: EE }, minsAgo(60)), 7, "ownerless strategy rows only");
  assert.equal((await readOpenPaperOrders({ user: u.alice })).length, 1);
  const closes = await readPaperCloses({ user: u.alice });
  assert.deepEqual(closes.map((c) => c.pnl), [-50], "CANCELLED without closed_at is not settled");
  assert.equal(realizedOf({ profitLoss: null, exitPrice: 1.095, entryPrice: 1.1, direction: "BUY", lotSize: 0.1 }) < 0, true,
    "a settled order without recorded P/L reads its sign from the fills, never as a win");
});

test("trader readiness: daily P/L is the settled paper_orders P/L (was always 0 on status 'CLOSED')", async () => {
  const r = await evaluateReadiness({ persist: false, userId: u.alice });
  assert.equal(r.metrics.dailyPnl, -50, "journal -500 and trades -300 are not paper facts");
  assert.equal(r.metrics.openPaperTrades, 1);
  assert.equal(r.metrics.sampleSize, 1);
});

test("missing coverage stays conservative: switching paper accounts does not reset the losing streak", async () => {
  const governor = await loadTradingActivity(u.switcher, "PAPER");
  assert.equal(governor!.consecutiveLosses, 0, "the governor reads the new active account (no closes yet)");
  assert.equal(await paperLosingStreak(u.switcher, governor), 2, "the trade-decision streak carries the old account's two losses");
  assert.equal(await paperLosingStreak(u.switcher, { consecutiveLosses: 3 }), 3, "never shorter than the governor's own streak");
});

test("tenant isolation: another trader's paper_orders never count", async () => {
  assert.equal(await paperLosingStreak(u.alice, null), 1, "alice's only settled loss; bob's -999 is not hers");
  const r = await evaluateReadiness({ persist: false, userId: u.alice });
  assert.notEqual(r.metrics.dailyPnl, -999 - 50);
  const bobCtx = await buildRiskContext(intent(u.bob, "PAPER"), { facts: { quote: null, halt: null } });
  assert.equal(bobCtx.daily.realizedPnl, -999);
  assert.equal(bobCtx.positions.length, 0);
});

test("DEMO unchanged: the DEMO governor still reads trades, untouched by paper_orders", async () => {
  const act = await loadTradingActivity(u.alice, "DEMO");
  assert.equal(act!.source, "trades");
  assert.equal(act!.consecutiveLosses, 1, "the legacy DEMO loss; paper rows are not DEMO facts");
  const ctx = await buildRiskContext(intent(u.alice, "DEMO"), { facts: { quote: null, halt: null } });
  assert.equal(ctx.daily.realizedPnl, -300);
});
