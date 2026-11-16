// Truth: the rule-contract evaluator (POST /rule-contracts/:id/evaluate) said
// "risk X% exceeds limit" from |entry − SL| × lots × 100 ÷ a fixed 10,000.
// A 1.00-lot EURUSD trade with a 50-pip stop risks $500 — 5% of a $10,000
// paper account — but read 0.01% and passed a 2% rule.
//
// Now the loss at the stop is sized at the instrument's contract size
// (paperPnl → lib/mt5/contractSize.ts) and divided by the order's own paper
// account starting balance. A trade whose risk cannot be sized is reported
// as not checked (INFO), never as within the rule.
//
// Offline: the REAL router runs on loopback over an in-memory db fake.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const router = (await import("../ruleContracts.js")).default;

const CONTRACT = {
  id: 3, userId: 7, contractName: "My Rules", maxTradesPerDay: null, maxDailyLossPercent: null,
  maxRiskPerTradePercent: 0.02, allowedSessions: "", allowedSymbols: "", requiredRrMinimum: null,
  cooldownAfterLosses: null, noTradeConditions: "", isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095, status: "OPEN",
    openedAt: new Date(), closedAt: null, exitPrice: null, profitLoss: 0,
    strategyId: null, tradePlanId: null, decisionId: null, clientRequestKey: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

type V = { type: string; severity: string; message: string; tradeId?: number };
async function evaluate(orders: unknown[], startingBalance = 10_000) {
  fake = createFakeDb({
    trading_rule_contracts: [CONTRACT],
    paper_orders: orders,
    paper_accounts: [{ id: 1, userId: 7, startingBalance }],
  });
  let out: { summary: Record<string, number>; violations: V[] } | null = null;
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/rule-contracts/3/evaluate`, { method: "POST" });
    out = await r.json() as typeof out;
    assert.equal(r.status, 200, JSON.stringify(out));
  });
  return out!;
}

test("1.00 lot EURUSD, 50-pip stop on a $10,000 account: risk 5.00% exceeds a 2% rule (not 0.01%)", async () => {
  const { violations, summary } = await evaluate([order({})]);
  const risk = violations.filter((v) => v.type === "OVER_RISK");
  assert.equal(risk.length, 1, JSON.stringify(violations));
  assert.equal(risk[0]!.severity, "HARD");
  assert.equal(risk[0]!.message, "EURUSD risk 5.00% exceeds limit 2.00%");
  assert.equal(summary["respectedCount"], 0);
});

test("the percentage is of the order's own paper account starting balance", async () => {
  const { violations, summary } = await evaluate([order({})], 100_000);
  assert.deepEqual(violations.filter((v) => v.type.includes("RISK")), []);
  assert.equal(summary["respectedCount"], 1);
});

test("risk that cannot be sized is reported as not checked, never as within the rule", async () => {
  const { violations, summary } = await evaluate([
    order({ id: 2, symbol: "XAUUSD", entryPrice: 2380, stopLoss: 2370, takeProfit: 2400 }),
  ]);
  assert.equal(violations.some((v) => v.type === "OVER_RISK"), false);
  const unmeasured = violations.find((v) => v.type === "RISK_UNMEASURED");
  assert.ok(unmeasured, JSON.stringify(violations));
  assert.equal(unmeasured.severity, "INFO");
  assert.match(unmeasured.message, /^XAUUSD risk per trade not checked against your 2\.00% limit: contract size for XAUUSD is unknown/);
  assert.equal(summary["respectedCount"], 0);
});
