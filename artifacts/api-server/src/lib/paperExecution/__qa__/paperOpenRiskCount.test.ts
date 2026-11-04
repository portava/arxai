// Execution safety (round-3 safety review, s-exec): open paper positions fed
// their contract-sized floating P/L into the Risk Governor's daily-loss check
// and into the equity every percent cap is valued on. Before contract sizing
// (16c8a1a0) every open position was valued at the paper risk model (price
// move × lots × 100), so for a small contract the daily check read a 100×
// smaller floating loss than 16c8a1a0 did, and for a currency pair the equity
// carried a 1,000× larger floating gain. Example (the finding's): a $250 daily
// cap, nothing realized today, one open US30 BUY at 1 unit per lot, 0.01 lot,
// 300 points down. Sized floating −3 passed the daily check; 16c8a1a0 read
// −300 and blocked.
//
// The governor now values each open position at the lower of its sized and
// its ×100 value at the price the paper venue marks it at
// (paperExecution/paperOpenRisk.ts over tradeEngine/paperMark.ts), never above
// the floating P&L the account stores, read-only. A market-priced position
// with no market quote for its symbol is counted at its stop and named.
//
// The REAL governor, mark and sizing run; the database, the paper book read
// side, the broker contract specs, limits and stop switches are stubbed.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/paperExecution/__qa__/paperOpenRiskCount.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
const writes: string[] = [];
const dbProxy = new Proxy({}, {
  get: (_t, p) => {
    if (p === "update") return (...a: unknown[]) => { writes.push("update"); return (fake.db.update as (...x: unknown[]) => unknown)(...a); };
    return (fake.db as Record<string | symbol, unknown>)[p];
  },
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

// Broker contract specs by symbol (the fake db cannot filter by symbol).
const SPECS: Record<string, { contractSize: number; profitCurrency: string }> = { US30: { contractSize: 1, profitCurrency: "USD" } };
const realContract = await import("../../mt5/contractSize.js");
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async (_userId: number, symbol: string) => realContract.decideContractSize({
      symbol, brokerContractSize: SPECS[symbol]?.contractSize ?? null, brokerProfitCurrency: SPECS[symbol]?.profitCurrency ?? null,
    }),
  },
});

const { resolveEffectiveLimits } = await import("../../riskGovernor/preTrade.js");
const LIMITS = {
  ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }),
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null,
  maxDailyLossPercent: null as number | null, maxDailyLossAmount: 250 as number | null, maxDrawdownPercent: null,
};
const realLimitSettings = await import("../../riskGovernor/limitSettings.js");
mock.module("../../riskGovernor/limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});

type Row = Record<string, unknown>;
const state: { account: Row; open: Row[] } = { account: {}, open: [] };
const realBook = await import("../../tradeEngine/paperBookReader.js");
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    readActivePaperAccount: async () => state.account,
    readOpenPaperOrders: async () => state.open,
    readPaperOrdersOpenedSince: async () => [],
    sumPaperRealizedSince: async () => 0,
    readPaperCloses: async () => [],
    countPaperOpenedSinceStillOpen: async () => 0,
  },
});

const { buildRiskContext, enforcePreTradeRisk } = await import("../../riskGovernor/enforce.js");
const { paperRiskCountNote } = await import("../../riskGovernor/riskProfile.js");
const { getMockPrice } = await import("../../tradeEngine/paperVenue.js");
const { valueOpenPaperPositions } = await import("../paperOpenRisk.js");

const NOW = new Date();
const account = (equity: number, balance = 10_000) => ({
  id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: balance, equity, marginUsed: 0, isActive: 1,
});
const openOrder = (over: Row): Row => ({
  id: 41, userId: 7, paperAccountId: 3, status: "OPEN", orderType: "MARKET", strategyId: null, closedAt: null,
  exitPrice: null, profitLoss: 0, openedAt: new Date(NOW.getTime() - 3_600_000), ...over,
});
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const fxQuote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };
const rule = (r: { rules: Array<{ rule: string; outcome: string; reason: string | null }> }, id: string) => r.rules.find((x) => x.rule === id)!;

// A simulator-priced US30 BUY 0.01 lot, 300 points down at the simulator's price now.
const usPx = getMockPrice("US30", NOW.getTime());
const US30_DOWN_300 = openOrder({ symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: usPx + 300, stopLoss: usPx - 500, takeProfit: usPx + 1_000 });

test("the finding's case: an open US30 position 300 points down counts −300 (the ×100 value), not the sized −3, and the $250 daily cap blocks", async () => {
  state.account = account(10_000 - 3); // markToMarket stored the sized −3
  state.open = [US30_DOWN_300];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.ok(Math.abs(ctx.daily.floatingPnl! - -300) < 1e-6, `floating ${ctx.daily.floatingPnl} (was −3)`);
  assert.ok(Math.abs(ctx.daily.bookedFloatingPnl! - -3) < 1e-6, "the stored floating rides along");
  assert.ok(Math.abs(ctx.account!.equity! - (10_000 - 300)) < 1e-6, `risk equity ${ctx.account!.equity}`);
  assert.equal(ctx.account!.bookedEquity, 10_000 - 3, "the shown equity stays booked");
  const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
  const daily = rule(res, "daily_loss_limit");
  assert.equal(daily.outcome, "BLOCK", "16c8a1a0 blocked this (−300 ≤ −250); the sized −3 let it through");
  assert.match(daily.reason!, /^Daily loss 300 reached the 250 cap\./);
  assert.match(daily.reason!, /open positions count -300 \(the paper account shows -3 floating\)/);
  assert.match(daily.reason!, /values each open position at the lower of its sized and its price move × lots × 100 value/);
  assert.match(paperRiskCountNote(ctx)!, /open positions are counted at -\$300\.00 \(the paper account shows -\$3\.00 floating\)/);
});

test("a currency-pair gain counts at its ×100 value in the equity every cap is valued on, not the sized +500", async () => {
  // 1 lot EURUSD, 50 pips up at the simulator's price: sized +500 (100,000 units), ×100 +0.5.
  const px = getMockPrice("EURUSD", NOW.getTime());
  state.account = account(10_500);
  state.open = [openOrder({ symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: px - 0.005, stopLoss: px - 0.01, takeProfit: px + 0.01 })];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.ok(Math.abs(ctx.daily.floatingPnl! - 0.5) < 1e-4, `floating ${ctx.daily.floatingPnl}`);
  assert.ok(Math.abs(ctx.account!.equity! - 10_000.5) < 1e-4, `risk equity ${ctx.account!.equity} (was 10,500)`);
  assert.equal(ctx.account!.bookedEquity, 10_500);
  assert.ok(ctx.account!.equity! <= 10_500 && ctx.account!.equity! <= 10_000 + 0.5 + 1e-4, "never above the booked nor the ×100 equity");
});

test("never above the stored floating P&L: a fresh value above the stored figure changes nothing", async () => {
  state.account = account(10_000 - 400); // a stored floating loss larger than the position's value now
  state.open = [US30_DOWN_300];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.equal(ctx.daily.floatingPnl, -400);
  assert.equal(ctx.daily.bookedFloatingPnl, undefined);
  assert.equal(ctx.account!.equity, 10_000 - 400);
  assert.equal(ctx.account!.bookedEquity, undefined);
});

test("a market-priced position is marked at the order's own market quote for its symbol", async () => {
  state.account = account(10_000 - 3);
  state.open = [openOrder({ ...US30_DOWN_300, strategyId: "build_ee_paper_execution", entryPrice: 40_300, stopLoss: 39_800, takeProfit: 41_000 })];
  const us30 = { ...intent, symbol: "US30", stopLoss: 39_900, takeProfit: 40_200 };
  const ctx = await buildRiskContext(us30, { paperAccountId: 3, facts: { quote: { bid: 40_000, ask: 40_002, at: NOW, source: "REAL:test" }, now: NOW } });
  // Marked at the bid 40,000: 300 points down, −300 at ×100.
  assert.ok(Math.abs(ctx.daily.floatingPnl! - -300) < 1e-6, `floating ${ctx.daily.floatingPnl}`);
  assert.equal(ctx.daily.openValuedAtStop, undefined);
});

test("a market-priced position with no market quote for it is counted at its stop, and every note names it", async () => {
  state.account = account(10_000 - 3);
  // EE BUY US30 0.01 lot, entry 40,300, stop 39,800: −5 sized, −500 at ×100 at the stop.
  state.open = [openOrder({ ...US30_DOWN_300, strategyId: "build_ee_paper_execution", entryPrice: 40_300, stopLoss: 39_800, takeProfit: 41_000 })];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.ok(Math.abs(ctx.daily.floatingPnl! - -500) < 1e-6, `floating ${ctx.daily.floatingPnl} (no quote: never 0, never the stored sized figure)`);
  assert.deepEqual(ctx.daily.openValuedAtStop, ["US30"]);
  const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
  assert.match(rule(res, "daily_loss_limit").reason!, /the open US30 position is counted at its stop because no market quote for it was read with this order/);
  assert.match(paperRiskCountNote(ctx)!, /The open US30 position could not be valued at a current price here \(no market quote for it was read\), so it is counted at its stop/);
  // A simulator price for the intent's symbol is not a market quote for a market-priced position.
  const same = await valueOpenPaperPositions([{ symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: 40_300, stopLoss: 39_800, strategyId: "build_ee_paper_execution", userId: 7 }],
    { now: NOW, userId: 7, quote: { symbol: "US30", bid: 40_250, ask: 40_250, source: "paper_simulator_price" } });
  assert.deepEqual(same.valuedAtStop, ["US30"]);
});

test("a simulator-priced position whose stop the simulator price crossed is valued at its stop, as markToMarket settles it", async () => {
  const v = await valueOpenPaperPositions([{ symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: usPx + 2_000, stopLoss: usPx + 1_000, takeProfit: usPx + 3_000, userId: 7 }],
    { now: NOW, userId: 7 });
  assert.ok(Math.abs(v.total - -1_000) < 1e-6, `${v.total}: (stop − entry) × 0.01 × 100`);
  assert.deepEqual(v.valuedAtStop, []);
});

test("read-only: valuing open positions settles nothing and writes no row (the governor's preview reads it too)", async () => {
  state.account = account(10_000 - 3);
  state.open = [US30_DOWN_300];
  writes.length = 0;
  const before = fake.inserts.length;
  await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
  assert.deepEqual(writes, []);
  assert.equal(fake.inserts.length, before);
});
