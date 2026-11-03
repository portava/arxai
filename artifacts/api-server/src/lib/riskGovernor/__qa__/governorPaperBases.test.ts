// Risk Governor (PAPER) — round-3 review, group r2-governor: the paper facts
// the governor loads cover what their refusals say they cover.
//
//   - the week's P/L that rule 13's weekly loss cap reads covers every close
//     of the last 7 days, not only the newest 50 (the activity read that the
//     losing streak and the cooldown use), and so does today's trade count;
//
// The REAL governor and fact loader run; the paper book read side is stubbed
// with a store that honours the reads' `since` and `limit` (newest close
// first), and the database, limits and stop switches are stubbed.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/governorPaperBases.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const { resolveEffectiveLimits } = await import("../preTrade.js");
const BASE_LIMITS = resolveEffectiveLimits({ userSettings: null, adminLimits: null });
const LIMITS = {
  ...BASE_LIMITS,
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null,
  maxDailyLossPercent: null as number | null, maxDailyLossAmount: null as number | null,
  maxDrawdownPercent: null as number | null,
  discipline: { ...BASE_LIMITS.discipline, maxWeeklyLossAmount: null as number | null, maxTradesPerDay: null as number | null },
};
const realLimitSettings = await import("../limitSettings.js");
mock.module("../limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});

type Row = Record<string, unknown> & { closedAt?: Date | null };
const state: { account: Row | null; open: Row[]; closes: Row[] } = { account: null, open: [], closes: [] };
const realBook = await import("../../tradeEngine/paperBookReader.js");
const { paperRiskTotals } = await import("../../paperExecution/paperPnl.js");
const settled = (since?: Date) => state.closes
  .filter((c) => !since || (c.closedAt as Date).getTime() >= since.getTime())
  .sort((a, b) => (b.closedAt as Date).getTime() - (a.closedAt as Date).getTime());
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    readActivePaperAccount: async () => state.account,
    readOpenPaperOrders: async () => state.open,
    readPaperOrdersOpenedSince: async () => [],
    countPaperOpenedSinceStillOpen: async () => 0,
    sumPaperRealizedSince: async (_s: unknown, since: Date) => paperRiskTotals(settled(since) as never).risk,
    readPaperCloses: async (_s: unknown, opts: { since?: Date; limit?: number } = {}) => {
      const rows = settled(opts.since);
      return (opts.limit != null ? rows.slice(0, opts.limit) : rows)
        .map((o) => ({ ...o, closedAt: o.closedAt, pnl: realBook.realizedOf(o as never) }));
    },
  },
});

const { buildRiskContext, enforcePreTradeRisk, loadTradingActivity } = await import("../enforce.js");

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const ACCOUNT = { id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
let nextId = 100;
/** A settled US30 0.1-lot order booked at the paper risk model (move × lots × 100 = the stored figure). */
const close = (points: number, closedAt: Date, over: Row = {}): Row => ({
  id: nextId++, userId: 7, paperAccountId: 3, symbol: "US30", direction: "BUY", lotSize: 0.1, orderType: "MARKET",
  status: points < 0 ? "CLOSED_SL" : "CLOSED_TP", strategyId: null, entryPrice: 40_000, exitPrice: 40_000 + points,
  profitLoss: points * 0.1 * 100, stopLoss: 39_000, takeProfit: 41_000, openedAt: new Date(closedAt.getTime() - 600_000), closedAt, ...over,
});
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const fxQuote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };
const rule = (r: { rules: Array<{ rule: string; outcome: string; reason: string | null }> }, id: string) => r.rules.find((x) => x.rule === id)!;

// ── Finding 3: the week's P/L covers the whole week ─────────────────────────
test("the weekly loss cap reads every close of the last 7 days: 10 older −100 losses and 50 newer closes that net 0 read −1,000, not 0", async () => {
  // Oldest first: ten −100 losses six days ago, then 50 closes over the last
  // five days alternating +100 / −100 (net 0), the newest a win.
  state.closes = [
    ...Array.from({ length: 10 }, (_v, i) => close(-10, hoursAgo(6 * 24 - i))),
    ...Array.from({ length: 50 }, (_v, i) => close(i % 2 ? 10 : -10, hoursAgo(1 + 2 * (49 - i)))),
  ];
  state.account = { ...ACCOUNT, currentBalance: 9_000, equity: 9_000 };
  state.open = [];
  const act = await loadTradingActivity(7, "PAPER", { paperAccountId: 3, now: NOW });
  assert.ok(act);
  assert.equal(act.weekRealizedPnl, -1_000, `the week's P/L read only the newest 50 closes (${act.weekRealizedPnl})`);
  assert.equal(act.consecutiveLosses, 0, "the losing streak still reads the newest closes");
  assert.equal(act.lastClosedWasLoss, false);
  LIMITS.discipline.maxWeeklyLossAmount = 500;
  try {
    const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
    const d = rule(res, "trading_discipline");
    assert.equal(d.outcome, "BLOCK", "a $500 weekly cap passed on a −1,000 week");
    assert.match(d.reason!, /this week's loss 1000 reached your weekly cap of 500/);
  } finally {
    LIMITS.discipline.maxWeeklyLossAmount = null;
  }
});

test("today's trade count covers every close today, not only the newest 50", async () => {
  const dayStart = new Date(NOW); dayStart.setUTCHours(0, 0, 0, 0);
  const span = NOW.getTime() - dayStart.getTime();
  state.closes = Array.from({ length: 60 }, (_v, i) => close(i % 2 ? -1 : 1, new Date(dayStart.getTime() + (span * (i + 1)) / 61)));
  state.account = { ...ACCOUNT };
  state.open = [];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.equal(ctx.activity?.tradesToday, 60, `today's trades read only the newest 50 closes (${ctx.activity?.tradesToday})`);
});
