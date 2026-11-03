// Truth: Ruby's getPropFirmModeStatus mirrors the Prop Challenge evaluator's
// math, so it must also say what that math measures. Drawdown and daily loss
// are a running balance of realised P&L from closed demo trades (open
// positions are not marked to market), and "max risk per trade" is each
// closed trade's realised loss against the day's starting balance (risk at
// entry is not measured). The page says this; Ruby said plain "Drawdown",
// "Daily loss" and "exceeds max risk per trade", with no basis and no count of
// the open positions left out.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "../../../routes/__qa__/_fakeRouteDb.js";

const STARTED = new Date(Date.now() - 2 * 86_400_000);
const challenge = {
  id: 5, userId: 7, paperAccountId: 3, challengeName: "Practice", startingBalance: 10_000,
  profitTarget: 0.08, maxDailyLoss: 0.01, maxTotalDrawdown: 0.012, minTradingDays: 1, maxTradingDays: 30,
  consistencyRulePercent: 1, status: "ACTIVE", failureReason: null, startedAt: STARTED, completedAt: null,
  trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.01, maxOpenTrades: 100, maxPendingOrders: 100, maxPositionSize: 100,
  newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 1, strictGuardrailsEnabled: 0,
  createdAt: STARTED,
};
// Closed today so the daily-loss figure is today's.
const closedAt = new Date();
const orders = [
  { id: 11, userId: 7, paperAccountId: 3, status: "CLOSED", openedAt: STARTED, closedAt, profitLoss: 2, lotSize: 0.1 },
  { id: 12, userId: 7, paperAccountId: 3, status: "CLOSED", openedAt: STARTED, closedAt, profitLoss: -150, lotSize: 0.1 },
  // Two open positions: their floating P&L is not on the row and is not read.
  { id: 13, userId: 7, paperAccountId: 3, status: "OPEN", openedAt: new Date(), closedAt: null, profitLoss: 0, lotSize: 1 },
  { id: 14, userId: 7, paperAccountId: 3, status: "OPEN", openedAt: new Date(), closedAt: null, profitLoss: 0, lotSize: 1 },
];
const fake = createFakeDb({ prop_challenges: [challenge], paper_orders: orders });
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });
const realNotify = await import("../../notifications/service.js");
mock.module("../../notifications/service.js", { namedExports: { ...realNotify, notify: async () => undefined } });

const { getPropFirmModeStatus } = await import("../tools.js");
const router = (await import("../../../routes/propChallenges.js")).default;

async function pageSummary(): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/prop-challenges/5/evaluate`, { method: "POST" });
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body.summary as Record<string, any>;
}

test("Ruby names the closed-trade basis of drawdown and daily loss, and the open positions left out — as the page does", async () => {
  const out = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await pageSummary();

  assert.equal(out.progress.drawdownBasis, "CLOSED_TRADES_ONLY");
  assert.equal(out.progress.openPositionsNotCounted, 2);
  assert.equal(out.progress.drawdownNote, page.drawdownNote, "Ruby and the page give one note");
  assert.match(String(out.progress.drawdownNote), /2 open positions are not counted/);

  const messages = [...out.violations, ...out.warnings] as string[];
  const dd = messages.filter((m) => /drawdown|daily loss/i.test(m) && !/trailing/i.test(m));
  assert.ok(dd.length >= 2, `drawdown and daily-loss breaches are reported: ${JSON.stringify(messages)}`);
  for (const m of dd) assert.match(m, /^Closed-trade (drawdown|daily loss) /, m);
});

test("Ruby reports max risk per trade as a realised loss checked after close, not risk at entry", async () => {
  const out = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await pageSummary();

  assert.equal(out.extendedRuleSignals.riskPerTradeBasis, "REALISED_LOSS_AFTER_CLOSE");
  assert.equal(out.extendedRuleSignals.riskPerTradeNote, page.riskPerTradeNote);
  assert.equal(out.extendedRuleSignals.largestTradeRiskPct, undefined, "a realised loss is not labelled trade risk");
  assert.ok(Math.abs(out.extendedRuleSignals.largestRealisedTradeLossPct - 150 / 10_000) < 1e-9);

  const w = (out.warnings as string[]).find((m) => m.startsWith("Trade #12"));
  assert.ok(w, "the -150 trade breaches the 1% limit");
  assert.match(w, /realised loss/);
  assert.match(w, /risk at entry is not measured/);
  assert.doesNotMatch(w, /^Trade #12 loss /);
});

test("Ruby labels trailing drawdown closed-trade too, with the page's note", async () => {
  const saved = {
    trailingDrawdownEnabled: challenge.trailingDrawdownEnabled,
    trailingDrawdownAmount: challenge.trailingDrawdownAmount,
    trailingDrawdownType: challenge.trailingDrawdownType,
  };
  challenge.trailingDrawdownEnabled = 1;
  challenge.trailingDrawdownAmount = 0.01;
  challenge.trailingDrawdownType = "TRAILING";
  try {
    const out = await getPropFirmModeStatus(7) as Record<string, any>;
    const page = await pageSummary();
    const td = ([...out.violations, ...out.warnings] as string[]).filter((m) => /trailing drawdown/i.test(m));
    assert.ok(td.length > 0, "the trailing limit is breached");
    for (const m of td) assert.match(m, /^Closed-trade trailing drawdown /, m);
    assert.equal(out.progress.drawdownNote, page.drawdownNote);
    assert.match(String(out.progress.drawdownNote), /trailing drawdown/i);
  } finally {
    Object.assign(challenge, saved);
  }
});
