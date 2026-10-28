// Truth: a paper stop or target hit whose amount could not be sized (no
// broker contract spec and not a fiat pair, e.g. V75 for an ownerless Build EE
// order) is settled with profit_loss 0, a placeholder the column cannot be
// empty of. Two surfaces read that 0 as a measured result:
//   - the auto-debrief classified the close by P&L alone, so a target hit read
//     BREAKEVEN ("Avoided a loss"), with BREAKEVEN lessons and learning
//     deltas, while paper_executions said PAPER_CLOSED_WIN;
//   - the paper account balance (starting balance + Σ profit_loss) did not
//     move, and nothing said a close was left unsized.
// The outcome is known from the price move; only the amount is not. The
// debrief now records WIN / LOSS from the move with pnl null and says the P&L
// was not sized; the balance counts the close the way the risk read side does
// and the account says how many closes were not sized and how they count.
//
// Offline: the REAL monitor, auto-debrief and paper venue over db fakes.
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
let nextId = 5000;
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
      return chain(() => [{ id: nextId++, createdAt: new Date(), ...values }]);
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
mock.module("../../marketData/marketDataService.js", {
  namedExports: { getMarketData: async () => { throw new Error("tests force the price"); } },
});
const settled: Array<{ status: string; exitPrice: number; pnl: number }> = [];
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    settlePaperTrade: async (a: { status: string; exitPrice: number; pnl: number }) => { settled.push(a); },
    fillPaperTrade: async () => { throw new Error("not used"); },
  },
});

const { runPaperMonitor } = await import("../paperExecutionMonitor.js");
const { runAutoDebrief } = await import("../../autoDebriefService.js");
const { markToMarket } = await import("../../tradeEngine/paperVenue.js");

function reset() {
  counts.clear(); inserts.length = 0; sets.length = 0; settled.length = 0;
  selectRows = () => [];
}
beforeEach(reset);

function v75(over: Row = {}): Row {
  return {
    id: 61, userId: null, paperAccountId: 9, decisionId: null, symbol: "V75", direction: "BUY",
    orderType: "MARKET", lotSize: 0.01, entryPrice: 100, stopLoss: 90, takeProfit: 110,
    status: "OPEN", strategyId: "build_ee_paper_execution", tradePlanId: null, clientRequestKey: null,
    openedAt: new Date("2026-10-20T08:00:00Z"), closedAt: null, exitPrice: null, profitLoss: 0,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

/** The row the real monitor settles for `order` at `price` (the venue write is captured). */
async function settleThroughMonitor(order: Row, price: number): Promise<Row> {
  selectRows = (t) => (t === "paper_orders" ? [order] : []);
  const s = await runPaperMonitor({ forcePrice: price });
  assert.equal(s.closed, 1);
  const w = settled[0]!;
  reset();
  return { ...order, status: w.status, exitPrice: w.exitPrice, profitLoss: w.pnl, closedAt: new Date("2026-10-20T09:00:00Z") };
}

async function debrief(row: Row) {
  selectRows = (t) => (t === "paper_orders" ? [row] : []);
  const r = await runAutoDebrief(row["id"] as number, { triggeredBy: "test" });
  assert.equal(r.status, "created", JSON.stringify(r));
  const ins = inserts.find((i) => i.table === "post_trade_debriefs")!;
  return { r, ins: ins.values, meta: ins.values["autoMeta"] as Row, learning: r.learningPayload as Row };
}

test("V75 target hit that could not be sized: the monitor stores 0 and calls it a WIN", async () => {
  selectRows = (t) => (t === "paper_orders" ? [v75()] : []);
  const s = await runPaperMonitor({ forcePrice: 111 });
  assert.equal(settled[0]!.pnl, 0);
  assert.equal(s.closures[0]!.outcome, "WIN");
});

test("auto-debrief: an unsized target hit is a WIN from the price move, with pnl withheld, never BREAKEVEN", async () => {
  const row = await settleThroughMonitor(v75(), 111);
  const { r, ins, meta, learning } = await debrief(row);
  assert.equal(r.result, "WIN", "was BREAKEVEN: the placeholder 0 read as a scratch trade");
  assert.equal(ins["result"], "WIN");
  assert.equal(meta["pnl"], null, "the amount is unknown, not 0");
  assert.match(String(meta["pnl_note"]), /not sized/i);
  assert.equal(learning["result"], "WIN");
  assert.equal(learning["pnl"], null);
  assert.doesNotMatch(String(ins["aiFeedback"]), /Avoided a loss|Won 0\.00/);
  assert.match(String(ins["aiFeedback"]), /not sized/i);
});

test("auto-debrief: an unsized stop-out is a LOSS from the price move", async () => {
  const row = await settleThroughMonitor(v75({ id: 62 }), 89);
  const { r, ins } = await debrief(row);
  assert.equal(r.result, "LOSS");
  assert.doesNotMatch(String(ins["aiFeedback"]), /Lost 0\.00/);
});

test("auto-debrief: a sized amount and a real flat exit are classified as before", async () => {
  const sized = await debrief(v75({ id: 63, status: "CLOSED_TP", exitPrice: 110, profitLoss: 10, closedAt: new Date() }));
  assert.equal(sized.r.result, "WIN");
  assert.equal(sized.meta["pnl"], 10);
  reset();
  const flat = await debrief(v75({ id: 64, status: "CLOSED_MANUAL", exitPrice: 100, profitLoss: 0, closedAt: new Date() }));
  assert.equal(flat.r.result, "BREAKEVEN", "an exit at entry is a real breakeven");
  assert.equal(flat.meta["pnl"], 0);
});

test("paper balance: an unsized stop-out moves the balance as the risk read side counts it, and the account says so", async () => {
  const sl = await settleThroughMonitor(v75({ userId: 4 }), 89);
  const account: Row = { id: 9, userId: 4, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
  selectRows = (t, nth) => {
    if (t === "paper_accounts") {
      const latest = sets.filter((s) => s.table === "paper_accounts").at(-1)?.values ?? {};
      return [{ ...account, ...latest }];
    }
    if (t === "paper_orders") return nth === 0 ? [] : [sl];
    return [];
  };
  const out = await markToMarket(9);
  assert.ok(out);
  // (90 − 100) × 0.01 lots at the governor's paper model (contract 100) = −10.
  assert.equal(out.currentBalance, 10_000 - 10, "was 10,000: the stop-out did not move the balance");
  assert.ok(out.pnlSizing, "the account reports how many closes were not sized");
  assert.equal(out.pnlSizing.unsizedClosedOrders, 1);
  assert.match(String(out.pnlSizing.note), /1 closed trade whose P&L could not be sized/);
  assert.match(String(out.pnlSizing.note), /not a measured amount/);
});

test("paper balance: no note when every close was sized", async () => {
  const account: Row = { id: 9, userId: 4, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
  const sized = v75({ userId: 4, status: "CLOSED_TP", exitPrice: 110, profitLoss: 25, closedAt: new Date() });
  selectRows = (t, nth) => {
    if (t === "paper_accounts") return [{ ...account, ...(sets.filter((s) => s.table === "paper_accounts").at(-1)?.values ?? {}) }];
    if (t === "paper_orders") return nth === 0 ? [] : [sized];
    return [];
  };
  const out = await markToMarket(9);
  assert.ok(out);
  assert.equal(out.currentBalance, 10_025);
  assert.equal(out.pnlSizing.unsizedClosedOrders, 0);
  assert.equal(out.pnlSizing.note, null);
});
