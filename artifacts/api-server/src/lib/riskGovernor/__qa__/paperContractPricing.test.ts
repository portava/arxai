// Execution safety: the paper venue now books every paper P&L at the
// instrument's contract size (paperExecution/paperPnl.ts: 100,000 units per
// lot for a currency pair), but the Risk Governor still priced every paper
// order with PAPER_LEDGER_INSTRUMENT (100 units per lot). A 5-lot EURUSD BUY
// with a 50-pip stop on a $10,000 account with a 1% per-trade cap ($100) was
// priced at 0.005 × 5 × 100 = $2.50 and allowed, then booked −$2,500 at the
// stop. The per-trade, portfolio-exposure, leverage, concentration and
// buying-power rules all bounded a figure 1,000× smaller than what the
// account loses on FX.
//
// loadPaperFacts now prices each symbol at the contract size the venue books
// it at, and never below the paper risk model (100 units, the 16c8a1a0
// pricing): a symbol that cannot be sized, or whose contract is smaller than
// 100 units per lot, keeps the paper risk model.
//
// The REAL enforce.ts context builder and rules run; the database, the paper
// book read side, limits and stop switches are stubbed. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/paperContractPricing.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const realDb = await import("@workspace/db");
const { resolveEffectiveLimits } = await import("../preTrade.js");

type Row = Record<string, unknown>;
const state: { specs: Row[]; open: Row[] } = { specs: [], open: [] };
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

const LIMITS = { ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }), maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDrawdownPercent: null };
const realLimitSettings = await import("../limitSettings.js");
mock.module("../limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
mock.module("../../safety/tradingHalt.js", {
  namedExports: { loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});
const ACCOUNT = { id: 3, userId: 7, startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    readActivePaperAccount: async () => ACCOUNT,
    readOpenPaperOrders: async () => state.open,
    readPaperOrdersOpenedSince: async () => [],
    sumPaperRealizedSince: async () => 0,
    readPaperCloses: async () => [],
    countPaperOpenedSinceStillOpen: async () => 0,
  },
});

const { buildRiskContext, evaluatePreTradeRisk, PAPER_LEDGER_INSTRUMENT } = await import("../enforce.js");

const NOW = new Date();
const quote = (bid: number, ask: number) => ({ bid, ask, at: NOW, source: "paper_simulator_price" });
type Intent = Parameters<typeof buildRiskContext>[0];
const open = (symbol: string, lots: number, stopLoss: number, takeProfit: number): Intent => ({
  userId: 7, venue: "PAPER", origin: "manual", action: "OPEN", symbol, side: "BUY", lots,
  entryPrice: null, stopLoss, takeProfit,
});
async function decide(intent: Intent, q: ReturnType<typeof quote>) {
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: q, now: NOW } });
  return { ctx, decision: evaluatePreTradeRisk(intent, ctx) };
}
const rule = (d: ReturnType<typeof evaluatePreTradeRisk>, id: string) => d.rules.find((r) => r.rule === id)!;

test("a 5-lot EURUSD BUY with a 50-pip stop is refused: the loss at stop is priced at the 100,000-unit lot the venue books (2,500), over the 1% cap (100)", async () => {
  state.specs = []; state.open = [];
  const { ctx, decision } = await decide(open("EURUSD", 5, 1.095, 1.11), quote(1.1, 1.1));
  assert.equal(ctx.instruments["EURUSD"]!.contractSize, 100_000, "was 100: PAPER_LEDGER_INSTRUMENT for every paper symbol");
  const perTrade = rule(decision, "per_trade_loss_limit");
  assert.equal(perTrade.outcome, "BLOCK", "was PASS at 2.50");
  assert.equal(perTrade.measured?.["lossAtStop"], 2500);
  assert.equal(decision.decision, "BLOCK");
});

test("the same order at the old pricing would have passed the per-trade rule (the gap this closes)", async () => {
  state.specs = []; state.open = [];
  const intent = open("EURUSD", 5, 1.095, 1.11);
  const { ctx } = await decide(intent, quote(1.1, 1.1));
  const old = evaluatePreTradeRisk(intent, { ...ctx, instruments: { EURUSD: PAPER_LEDGER_INSTRUMENT } });
  assert.equal(rule(old, "per_trade_loss_limit").outcome, "PASS");
  assert.equal(rule(old, "per_trade_loss_limit").measured?.["lossAtStop"], 2.5);
});

test("an open EURUSD position counts at its contract size in portfolio exposure and leverage", async () => {
  state.specs = [];
  state.open = [{ id: 1, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.1, stopLoss: 1.09 }];
  const { ctx, decision } = await decide(open("GBPUSD", 0.01, 1.25, 1.3), quote(1.26, 1.26));
  assert.equal(ctx.instruments["EURUSD"]!.contractSize, 100_000);
  // 0.01 × 1 lot × 100,000 = 1,000 open risk, over the 10% portfolio cap of 1,000 with the new trade added.
  assert.equal(rule(decision, "max_portfolio_exposure").measured?.["openRisk"], 1000);
  assert.equal(rule(decision, "max_portfolio_exposure").outcome, "BLOCK");
});

test("never below the 16c8a1a0 pricing: an unsizable symbol and a broker contract smaller than 100 units keep the paper risk model", async () => {
  state.open = [];
  state.specs = [];
  const v75 = await decide(open("V75", 1, 990, 1100), quote(1000, 1000));
  assert.equal(v75.ctx.instruments["V75"], PAPER_LEDGER_INSTRUMENT, "no broker spec and not a currency pair");
  state.specs = [{ symbol: "V75", contractSize: 1, profitCurrency: "USD" }];
  const spec1 = await decide(open("V75", 1, 990, 1100), quote(1000, 1000));
  assert.equal(spec1.ctx.instruments["V75"]!.contractSize, 100, "a 1-unit broker contract is never priced below the paper model");
  assert.equal(rule(spec1.decision, "per_trade_loss_limit").measured?.["lossAtStop"], 1000, "10 points × 1 lot × 100, as at 16c8a1a0");
});

test("a pair quoted against USD as the base (USDJPY) is converted with the order's price; with no price it keeps the paper model", async () => {
  state.open = []; state.specs = [];
  const { ctx, decision } = await decide(open("USDJPY", 1, 149, 152), quote(150, 150));
  const inst = ctx.instruments["USDJPY"]!;
  assert.equal(inst.contractSize, 100_000);
  assert.ok(Math.abs(inst.quoteToAccountFx! - 1 / 150) < 1e-12);
  // 1 yen × 1 lot × 100,000 / 150 ≈ 666.67 USD at the stop.
  assert.ok(Math.abs(Number(rule(decision, "per_trade_loss_limit").measured?.["lossAtStop"]) - 666.67) < 0.01);
  const noPrice = await buildRiskContext({ ...open("USDJPY", 1, 149, 152), action: "CLOSE" }, { paperAccountId: 3, facts: { quote: null, now: NOW } });
  assert.equal(noPrice.instruments["USDJPY"], PAPER_LEDGER_INSTRUMENT);
});
