// Truth: the Prop Challenge evaluator measures drawdown and daily loss from
// CLOSED demo trades only (running balance of realised P&L). Open positions'
// floating P&L is never read, so a challenge with open positions down 12% and
// flat closed P&L reports 0.00% drawdown. The evaluation must say so: which
// basis the figures use and how many open positions were not counted.
//
// It also checks "max risk per trade" as each closed trade's REALISED loss vs
// the day's starting balance; risk at entry (stop-loss distance) is never
// measured. The evaluation and the violation message must say that, not
// present it as a risk-at-entry check.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const STARTED = new Date(Date.now() - 2 * 86_400_000);
const challenge = {
  id: 5, userId: 7, paperAccountId: 3, challengeName: "Practice", startingBalance: 10_000,
  profitTarget: 0.08, maxDailyLoss: 0.05, maxTotalDrawdown: 0.10, minTradingDays: 1, maxTradingDays: 30,
  consistencyRulePercent: 1, status: "ACTIVE", failureReason: null, startedAt: STARTED, completedAt: null,
  trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.01, maxOpenTrades: 100, maxPendingOrders: 100, maxPositionSize: 100,
  newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 1, strictGuardrailsEnabled: 0,
};
const closedAt = new Date(Date.now() - 86_400_000);
const orders = [
  // Closed flat-ish: one +2 winner, one -150 loser (1.5% of day start > 1% limit).
  { id: 11, userId: 7, paperAccountId: 3, status: "CLOSED", openedAt: STARTED, closedAt, profitLoss: 2, lotSize: 0.1 },
  { id: 12, userId: 7, paperAccountId: 3, status: "CLOSED", openedAt: STARTED, closedAt, profitLoss: -150, lotSize: 0.1 },
  // Two open positions: their floating P&L is not on the row and is not read.
  { id: 13, userId: 7, paperAccountId: 3, status: "OPEN", openedAt: new Date(), closedAt: null, profitLoss: 0, lotSize: 1 },
  { id: 14, userId: 7, paperAccountId: 3, status: "OPEN", openedAt: new Date(), closedAt: null, profitLoss: 0, lotSize: 1 },
];
const fake = createFakeDb({ prop_challenges: [challenge], paper_orders: orders });
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });
const realNotify = await import("../../lib/notifications/service.js");
mock.module("../../lib/notifications/service.js", { namedExports: { ...realNotify, notify: async () => undefined } });
const router = (await import("../propChallenges.js")).default;

async function evaluate(): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/prop-challenges/5/evaluate`, { method: "POST" });
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("drawdown and daily loss say they are closed-trade figures and how many open positions were not counted", async () => {
  const { summary } = await evaluate();
  assert.equal(summary.drawdownBasis, "CLOSED_TRADES_ONLY");
  assert.equal(summary.openPositionsNotCounted, 2);
  assert.match(String(summary.drawdownNote), /closed demo trades only/i);
  assert.match(String(summary.drawdownNote), /2 open positions/i);
  assert.match(String(summary.drawdownNote), /not counted/i);
  // The measured figures themselves are unchanged.
  assert.ok(Math.abs(summary.maxDrawdownPct - 148 / 10_000) < 1e-9);
  assert.equal(summary.status, "ACTIVE");
});

test("drawdown and daily-loss violations name the closed-trade basis", async () => {
  const saved = { maxDailyLoss: challenge.maxDailyLoss, maxTotalDrawdown: challenge.maxTotalDrawdown };
  // Tighten both limits so the 1.48% closed-trade loss breaches them.
  challenge.maxDailyLoss = 0.01;
  challenge.maxTotalDrawdown = 0.012;
  try {
    const { violations } = await evaluate();
    const dd = (violations as Array<{ type: string; message: string }>).filter((x) => x.type === "TOTAL_DRAWDOWN" || x.type === "DAILY_LOSS");
    assert.deepEqual(dd.map((v) => v.type).sort(), ["DAILY_LOSS", "TOTAL_DRAWDOWN"]);
    for (const v of dd) assert.match(v.message, /^Closed-trade /);
  } finally {
    Object.assign(challenge, saved);
  }
});

test("max risk per trade is reported as a realised-loss check, not risk at entry", async () => {
  const { summary, violations } = await evaluate();
  assert.equal(summary.riskPerTradeBasis, "REALISED_LOSS_AFTER_CLOSE");
  assert.match(String(summary.riskPerTradeNote), /realised loss/i);
  assert.match(String(summary.riskPerTradeNote), /stop-loss distance\) is not measured/i);
  const v = (violations as Array<{ type: string; severity: string; message: string }>)
    .find((x) => x.type === "MAX_RISK_PER_TRADE" && x.severity === "WARN");
  assert.ok(v, "the -150 trade breaches the 1% limit");
  assert.match(v.message, /realised loss/i);
  assert.match(v.message, /risk at entry is not measured/i);
});

test("trailing drawdown is labelled closed-trade like total drawdown, and the note covers it", async () => {
  const saved = {
    trailingDrawdownEnabled: challenge.trailingDrawdownEnabled,
    trailingDrawdownAmount: challenge.trailingDrawdownAmount,
    trailingDrawdownType: challenge.trailingDrawdownType,
  };
  // Trailing drawdown on the same closed-trade running balance: the 1.48%
  // closed loss breaches a 1% trailing limit; the two open positions are not in it.
  challenge.trailingDrawdownEnabled = 1;
  challenge.trailingDrawdownAmount = 0.01;
  challenge.trailingDrawdownType = "TRAILING";
  try {
    const { summary, violations } = await evaluate();
    const td = (violations as Array<{ type: string; message: string }>).filter((x) => x.type === "TRAILING_DRAWDOWN");
    assert.ok(td.length > 0, "the trailing limit is breached");
    for (const v of td) assert.match(v.message, /^Closed-trade trailing drawdown /);
    assert.match(String(summary.drawdownNote), /trailing drawdown/i);
    assert.match(String(summary.drawdownNote), /closed demo trades only/i);
    assert.match(String(summary.drawdownNote), /2 open positions are not counted/);
  } finally {
    Object.assign(challenge, saved);
  }
});
