// Execution safety (round-3 review, p2-exec): the demo position sizer sized
// every paper order at 100 per 1.0 price move per lot (the paper risk model),
// while the pre-trade Risk Governor prices a paper order at the contract size
// the paper venue books it at (100,000 units for a currency pair). On a
// $10,000 account with a 1% per-trade limit, a EURUSD BUY with a 44-pip stop
// was sized at the 5-lot cap; the governor prices that at $2,200 at the stop
// and refuses it, so most automatic FX demo orders were refused.
//
// Paper execution now sizes with the governor's own pricing
// (paperExecutionService.sizePaperExecution: enforce.paperInstrumentModel over
// paperPnl.resolvePaperContract at the quote mid), at the equity the governor
// values its caps on, inside both per-trade limits, floored to the step. The
// lot is never larger than the 100-per-point sizing proposed, a symbol with no
// known contract keeps that sizing, and the governor is unchanged.
//
// The REAL sizer, contract resolution and governor run; the database, the
// paper book read side, limits and stop switches are stubbed. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/paperExecution/__qa__/paperSizerContract.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const realDb = await import("@workspace/db");
const { resolveEffectiveLimits } = await import("../../riskGovernor/preTrade.js");

type Row = Record<string, unknown>;
const state: { specs: Row[]; closes: Row[]; equity: number } = { specs: [], closes: [], equity: 10_000 };
function chain(rows: () => unknown[]) {
  const self: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(rows).then(ok, bad);
      if (prop === "catch") return (bad: (e: unknown) => unknown) => Promise.resolve().then(rows).catch(bad);
      return () => self;
    },
  });
  return self;
}
const fakeDb = {
  select: () => ({
    from: (table: Table) => chain(() => (getTableName(table) === "arx_symbol_specs" ? state.specs : [])),
  }),
  insert: () => ({ values: () => chain(() => [{ id: 1 }]) }),
  update: () => ({ set: () => chain(() => []) }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

type Limits = ReturnType<typeof resolveEffectiveLimits>;
let LIMITS: Limits = { ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }), maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDrawdownPercent: null };
const realLimitSettings = await import("../../riskGovernor/limitSettings.js");
mock.module("../../riskGovernor/limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});
const realBook = await import("../../tradeEngine/paperBookReader.js");
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    readActivePaperAccount: async () => ({ id: 3, userId: 7, startingBalance: 10_000, currentBalance: state.equity, equity: state.equity, marginUsed: 0, isActive: 1 }),
    readOpenPaperOrders: async () => [],
    readPaperOrdersOpenedSince: async () => [],
    sumPaperRealizedSince: async () => 0,
    readPaperCloses: async () => state.closes,
    countPaperOpenedSinceStillOpen: async () => 0,
  },
});

const { buildRiskContext, evaluatePreTradeRisk } = await import("../../riskGovernor/enforce.js");
const { calculatePaperPositionSize } = await import("../../riskGovernor/positionSizer.js");
const { sizePaperExecution } = await import("../paperExecutionService.js");

const NOW = new Date();
const SPECS: Record<string, Row> = {
  NAS100: { contractSize: 1, profitCurrency: "USD" },
  US30: { contractSize: 10, profitCurrency: "USD" },
  XAUUSD: { contractSize: 100, profitCurrency: "USD" },
};
const withSpec = (symbol: string) => { state.specs = SPECS[symbol] ? [SPECS[symbol]!] : []; };

interface Order { symbol: string; side: "BUY" | "SELL"; bid: number; ask: number; stopLoss: number }
/** The fill paper execution books at: the quote plus one basis point of slippage (applySimulatedFill). */
const fillOf = (o: Order) => {
  const slip = Math.max(0.00001, ((o.bid + o.ask) / 2) * 0.0001);
  return Number((o.side === "BUY" ? o.ask + slip : o.bid - slip).toFixed(5));
};
async function size(o: Order) {
  withSpec(o.symbol);
  return sizePaperExecution({
    userId: 7, accountId: 3, accountEquity: state.equity, symbol: o.symbol, fillPrice: fillOf(o), stopLoss: o.stopLoss,
    quote: { bid: o.bid, ask: o.ask }, limits: LIMITS,
  });
}
/** The sizing every paper order had before: 100 per point per lot, stored equity, percent limit only. */
function previous(o: Order) {
  return calculatePaperPositionSize({
    accountEquity: state.equity, entryPrice: fillOf(o), stopLoss: o.stopLoss,
    maxLotSizeOverride: Math.min(5, LIMITS.maxLotSize), riskPercentOverride: Math.min(0.01, LIMITS.maxRiskPerTradePercent / 100),
  }).capped_position_size;
}
/** The pre-trade governor's per-trade rule for `lots` of the order, as paper execution submits it. */
async function perTrade(o: Order, lots: number) {
  withSpec(o.symbol);
  const intent = {
    userId: 7, venue: "PAPER" as const, origin: "automation" as const, action: "OPEN" as const, symbol: o.symbol, side: o.side, lots,
    entryPrice: null, stopLoss: o.stopLoss, takeProfit: o.side === "BUY" ? o.ask * 1.05 : o.bid * 0.95,
  };
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: { bid: o.bid, ask: o.ask, at: NOW, source: "qa" }, now: NOW } });
  return evaluatePreTradeRisk(intent, ctx).rules.find((r) => r.rule === "per_trade_loss_limit")!;
}
function reset() {
  state.equity = 10_000; state.closes = [];
  LIMITS = { ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }), maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDrawdownPercent: null };
}

const EURUSD: Order = { symbol: "EURUSD", side: "BUY", bid: 1.0999, ask: 1.1001, stopLoss: 1.0957 };

test("EURUSD: the lot is sized at the 100,000-unit lot the governor prices, and the governor's per-trade rule passes it", async () => {
  reset();
  const prev = previous(EURUSD);
  assert.equal(prev, 5, "the 100-per-point sizing proposes the 5-lot cap");
  const before = await perTrade(EURUSD, prev);
  assert.equal(before.outcome, "BLOCK", "the governor refuses the 100-per-point lot");
  assert.equal(before.measured?.["lossAtStop"], 2200);

  const { sizing, valuePerUnitPerLot, instrument } = await size(EURUSD);
  assert.equal(valuePerUnitPerLot, 100_000);
  assert.equal(instrument.source, "paper_contract:FX_STANDARD_LOT");
  // $100 over a 45.1-pip stop (fill 1.10021) at $100,000 per 1.0 per lot = 0.2217, floored to 0.22.
  assert.equal(sizing.capped_position_size, 0.22);
  assert.equal(sizing.risk_amount, 100);
  const after = await perTrade(EURUSD, sizing.capped_position_size);
  assert.equal(after.outcome, "PASS", after.reason ?? "");
  assert.ok((after.measured?.["lossAtStop"] as number) <= 100);
});

test("USDJPY: the contract is converted to USD at the quote mid, as the governor converts it", async () => {
  reset();
  const o: Order = { symbol: "USDJPY", side: "SELL", bid: 149.99, ask: 150.01, stopLoss: 150.6 };
  const { sizing, valuePerUnitPerLot } = await size(o);
  assert.ok(Math.abs(valuePerUnitPerLot - 100_000 / 150) < 1e-6);
  assert.ok(sizing.capped_position_size < previous(o));
  assert.equal((await perTrade(o, sizing.capped_position_size)).outcome, "PASS");
});

test("an index whose contract is under 100 units keeps the 100-per-point sizing (the governor prices it there too)", async () => {
  reset();
  for (const o of [
    { symbol: "NAS100", side: "BUY", bid: 17_999, ask: 18_001, stopLoss: 17_950 },
    { symbol: "US30", side: "SELL", bid: 38_990, ask: 39_010, stopLoss: 39_200 },
  ] as Order[]) {
    const { sizing, valuePerUnitPerLot, instrument } = await size(o);
    assert.equal(valuePerUnitPerLot, 100, o.symbol);
    assert.equal(instrument.source, "paper_ledger_model", o.symbol);
    assert.equal(sizing.capped_position_size, previous(o), `${o.symbol}: unchanged`);
    assert.deepEqual(sizing, calculatePaperPositionSize({
      accountEquity: 10_000, entryPrice: fillOf(o), stopLoss: o.stopLoss, maxLotSizeOverride: 5, riskPercentOverride: 0.01,
    }), `${o.symbol}: the same result as before`);
  }
});

test("a symbol with no known contract keeps the 100-per-point sizing", async () => {
  reset();
  for (const o of [
    { symbol: "BTCUSD", side: "BUY", bid: 60_000, ask: 60_010, stopLoss: 59_000 },
    { symbol: "GER40", side: "BUY", bid: 18_000, ask: 18_002, stopLoss: 17_900 },
    { symbol: "EURGBP", side: "BUY", bid: 0.8499, ask: 0.8501, stopLoss: 0.845 },
  ] as Order[]) {
    const { sizing, valuePerUnitPerLot, instrument } = await size(o);
    assert.equal(valuePerUnitPerLot, 100, `${o.symbol}: no contract size or no USD rate`);
    assert.equal(instrument.source, "paper_ledger_model");
    assert.equal(sizing.capped_position_size, previous(o), `${o.symbol}: unchanged`);
  }
});

test("the equity the governor values its caps on and the per-trade money limit bound the lot too", async () => {
  reset();
  // A NAS100 loss booked at its 1-unit contract (−20) counts at the paper
  // risk model (5 points × 4 lots × 100 = −2,000), so the governor values its
  // caps on $10,000 − 1,980 = $8,020, and the sizer budgets 1% of that.
  state.closes = [{
    id: 1, symbol: "NAS100", direction: "BUY", lotSize: 4, entryPrice: 18_000, exitPrice: 17_995,
    profitLoss: -20, status: "CLOSED_SL", closedAt: new Date(NOW.getTime() - 86_400_000), pnl: -2_000,
  }];
  const { sizing, riskEquity } = await size(EURUSD);
  assert.equal(riskEquity, 10_000 - 1_980);
  assert.equal(sizing.risk_amount, 80.2);
  assert.equal(sizing.capped_position_size, 0.17, "$80.20 over the stop, floored");
  assert.equal((await perTrade(EURUSD, sizing.capped_position_size)).outcome, "PASS");

  reset();
  LIMITS = { ...LIMITS, maxRiskPerTradeAmount: 30 };
  const capped = await size(EURUSD);
  assert.equal(capped.sizing.risk_amount, 30);
  assert.equal(capped.sizing.capped_position_size, 0.06);
  assert.equal((await perTrade(EURUSD, capped.sizing.capped_position_size)).outcome, "PASS");
});

test("sweep: the lot is never larger than the 100-per-point sizing, and a contract-priced lot above the minimum stays inside the governor's per-trade limit", async () => {
  const orders: Order[] = [];
  for (const [symbol, mid, stops] of [
    ["EURUSD", 1.1, [0.0004, 0.0021, 0.0044, 0.012, 0.05]],
    ["GBPUSD", 1.27, [0.0007, 0.0033, 0.02]],
    ["USDJPY", 150, [0.07, 0.6, 3]],
    ["NAS100", 18_000, [3, 50, 400]],
    ["US30", 39_000, [10, 190]],
    ["XAUUSD", 2_350, [0.5, 12, 80]],
    ["BTCUSD", 60_000, [150, 1_000]],
    ["EURGBP", 0.85, [0.0006, 0.004]],
  ] as Array<[string, number, number[]]>) {
    for (const stop of stops) {
      const half = symbol === "EURUSD" || symbol === "GBPUSD" || symbol === "EURGBP" ? 0.0001 : mid * 0.00005;
      orders.push({ symbol, side: "BUY", bid: mid - half, ask: mid + half, stopLoss: mid - stop });
      orders.push({ symbol, side: "SELL", bid: mid - half, ask: mid + half, stopLoss: mid + stop });
    }
  }
  let checked = 0; let smaller = 0;
  for (const equity of [500, 10_000, 250_000]) {
    for (const pct of [0.25, 1, 3]) {
      for (const amount of [null, 15, 400]) {
        for (const maxLot of [0.05, 1, 5]) {
          for (const closes of [[], [{
            id: 9, symbol: "NAS100", direction: "SELL", lotSize: 2, entryPrice: 18_000, exitPrice: 18_010,
            profitLoss: -20, status: "CLOSED_SL", closedAt: new Date(NOW.getTime() - 3_600_000), pnl: -2_000,
          }]]) {
            for (const o of orders) {
              reset();
              state.equity = equity; state.closes = closes;
              LIMITS = { ...LIMITS, maxRiskPerTradePercent: pct, maxRiskPerTradeAmount: amount, maxLotSize: maxLot };
              const prev = previous(o);
              const { sizing, valuePerUnitPerLot, riskEquity } = await size(o);
              const lot = sizing.capped_position_size;
              assert.ok(lot <= prev, `${o.symbol} ${o.side} eq ${equity} ${pct}% amt ${amount} max ${maxLot}: ${lot} > ${prev}`);
              if (lot < prev) smaller++;
              if (valuePerUnitPerLot > 100 && lot > 0.01 && riskEquity > 0) {
                const rule = await perTrade(o, lot);
                assert.equal(rule.outcome, "PASS", `${o.symbol} ${o.side} lot ${lot}: ${rule.reason}`);
              }
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 2_000 && smaller > 100, `${checked} cases, ${smaller} smaller`);
});
