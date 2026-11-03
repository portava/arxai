// Truth: one paper order, one P&L unit. The Build EE monitor sizes paper P&L
// at the instrument's contract size (paperPnl), but the PAPER venue still used
// direction × move × lots × 100 for the same orders: markToMarket's equity,
// the trader's close (closePaperOrder) and the EE manual close
// (closePaperFill). A 1.00-lot EURUSD order up 100 pips read 1,000 unrealized
// in the monitor but added 1.00 to the account's equity, and booked 1.00 on a
// manual close against 1,000 on a monitor target close. Every venue path now
// sizes like the monitor. When an amount cannot be sized the close stores the
// 0 placeholder and says so, and the account's equity counts an open position
// at the paper risk model and says so; never a silent ×100.
//
// Offline: the REAL venue, pipeline and monitor over an in-memory db fake.
import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const realDb = await import("@workspace/db");

type Row = Record<string, unknown>;
let selectRows: (table: string, nth: number) => Row[] = () => [];
const inserts: Array<{ table: string; values: Row }> = [];
const sets: Array<{ table: string; values: Row }> = [];
function chain(resolve: () => unknown[]) {
  const self: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(resolve).then(ok, bad);
      if (prop === "catch") return (bad: (e: unknown) => unknown) => Promise.resolve().then(resolve).catch(bad);
      return () => self;
    },
  });
  return self;
}
const counts = new Map<string, number>();
const fakeDb = {
  select: (_cols?: unknown) => ({
    from: (table: Table) => {
      const name = getTableName(table);
      const nth = counts.get(name) ?? 0;
      counts.set(name, nth + 1);
      return chain(() => selectRows(name, nth));
    },
  }),
  insert: (table: Table) => ({
    values: (values: Row) => {
      inserts.push({ table: getTableName(table), values });
      return chain(() => [{ id: 900, ...values }]);
    },
  }),
  update: (table: Table) => ({
    set: (values: Row) => {
      sets.push({ table: getTableName(table), values });
      return chain(() => [{ id: 1 }]);
    },
  }),
  delete: () => chain(() => []),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

let quote = { bid: 1.09, ask: 1.0902 };
mock.module("../marketQuote.js", {
  namedExports: {
    currentQuote: async () => ({ ok: true, ...quote, at: new Date(), source: "REAL:qa" }),
  },
});
mock.module("../../marketData/marketDataService.js", {
  namedExports: { getMarketData: async () => { throw new Error("tests force the price"); } },
});
mock.module("../../riskGovernor/enforce.js", {
  namedExports: {
    enforcePreTradeRisk: async () => ({ allowed: true, decision: "ALLOW", blockedBy: [], auditEventId: 1, limits: null }),
  },
});
mock.module("../../autoDebriefService.js", {
  namedExports: { runAutoDebrief: async () => ({ status: "skipped" }) },
});

const { markToMarket, closePaperOrder } = await import("../paperVenue.js");
const { runPaperMonitor, closePaperManually } = await import("../../paperExecution/paperExecutionMonitor.js");

const ACCOUNT: Row = { id: 9, userId: 4, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
function eeOrder(over: Row = {}): Row {
  return {
    id: 71, userId: 4, paperAccountId: 9, decisionId: null, symbol: "EURUSD", direction: "BUY",
    orderType: "MARKET", lotSize: 1, entryPrice: 1.08, stopLoss: 1.07, takeProfit: 1.1,
    status: "OPEN", strategyId: "build_ee_paper_execution", tradePlanId: null, clientRequestKey: null,
    openedAt: new Date(), closedAt: null, exitPrice: null, profitLoss: 0, ...over,
  };
}
/** paper_orders reads: markToMarket reads open orders first, then the whole account. */
function book(open: Row[], all: Row[] = []) {
  selectRows = (t, nth) => {
    if (t === "paper_accounts") return [{ ...ACCOUNT, ...(sets.filter((s) => s.table === "paper_accounts").at(-1)?.values ?? {}) }];
    if (t === "paper_orders") return nth % 2 === 0 ? open : all;
    return []; // arx_symbol_specs: no broker spec
  };
}
const orderSet = () => sets.find((s) => s.table === "paper_orders")!.values;
const lastEvent = () => inserts.filter((i) => i.table === "paper_trade_events").at(-1)!.values;

beforeEach(() => {
  counts.clear(); inserts.length = 0; sets.length = 0; quote = { bid: 1.09, ask: 1.0902 };
  selectRows = () => [];
});

test("monitor and account equity agree on a 1.00-lot EURUSD position up 100 pips", async () => {
  book([eeOrder()]);
  const s = await runPaperMonitor({ forcePrice: 1.09 });
  assert.equal(s.updates[0]!.unrealizedPnl, 1000);
  counts.clear();
  const acct = await markToMarket(9);
  assert.ok(acct);
  assert.equal(acct.equity - acct.currentBalance, 1000, "was 1.00: equity used move × lots × 100");
  assert.equal(acct.pnlSizing.unsizedOpenPositions, 0);
});

test("EE manual close books the same contract-size amount the monitor would", async () => {
  book([eeOrder()]);
  const r = await closePaperManually(71, 4, { exitPrice: 1.09 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r as { pnl: number | null }).pnl, 1000, "was 1.00");
  assert.equal(orderSet()["profitLoss"], 1000);
  assert.match(String(lastEvent()["message"]), /EE manual close @ 1\.09000, P&L 1000\.00$/);
});

test("the trader's close of a real-priced order books the contract-size amount at the bid", async () => {
  book([eeOrder({ strategyId: "market_priced_simulated_open" })]);
  const r = await closePaperOrder({ userId: 4, orderId: 71, caller: "QA" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(orderSet()["profitLoss"], 1000, "was 1.00");
});

test("an unsized open position (V75, no broker spec): equity counts it at the paper risk model and the account says so", async () => {
  quote = { bid: 105, ask: 105.5 };
  book([eeOrder({ symbol: "V75", lotSize: 0.01, entryPrice: 100, stopLoss: 90, takeProfit: 120 })]);
  const s = await runPaperMonitor({ forcePrice: 105 });
  assert.equal(s.updates[0]!.unrealizedPnl, null, "the monitor withholds it");
  counts.clear();
  const acct = await markToMarket(9);
  assert.ok(acct);
  assert.equal(acct.pnlSizing.unsizedOpenPositions, 1);
  assert.ok(Math.abs(acct.equity - acct.currentBalance - 5) < 1e-9, "(105 − 100) × 0.01 × 100 at the paper risk model");
  assert.match(String(acct.pnlSizing.note), /1 open position whose P&L could not be sized/);
  assert.match(String(acct.pnlSizing.note), /not a measured amount/);
});

test("an unsized manual close stores the placeholder 0, returns pnl null and says it was not sized", async () => {
  book([eeOrder({ symbol: "V75", lotSize: 0.01, entryPrice: 100, stopLoss: 90, takeProfit: 120 })]);
  const r = await closePaperManually(71, 4, { exitPrice: 95 }) as { ok: boolean; pnl: number | null; pnlUnavailableReason: string | null };
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pnl, null, "was -5.00: a ×100 guess");
  assert.match(String(r.pnlUnavailableReason), /contract size/);
  assert.equal(orderSet()["profitLoss"], 0);
  assert.match(String(lastEvent()["message"]), /EE manual close @ 95\.00000, P&L not sized: .*placeholder/);
});

test("a simulator SL hit in markToMarket books the contract-size amount", async () => {
  // A trader-ticket order (not real-priced) whose stop is far above any simulator price: SL hit.
  book([eeOrder({ strategyId: null, stopLoss: 1e9, takeProfit: 2e9, entryPrice: 1e9 + 1 })]);
  await markToMarket(9);
  const set = orderSet();
  assert.equal(set["status"], "CLOSED_SL");
  const expected = Number(((1e9 - (1e9 + 1)) * 1 * 100_000).toFixed(2));
  assert.equal(set["profitLoss"], expected, "sized at the FX standard lot, not × 100");
});
