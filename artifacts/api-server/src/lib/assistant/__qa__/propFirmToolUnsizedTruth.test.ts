// Truth regression: getPropFirmModeStatus (the assistant restates it) read
// paper_orders.profit_loss as a measured result. The paper venue stores 0 for
// a close it could not size for the instrument (no contract size or currency
// conversion) on every close path, so a trader's manual V75 loss added
// nothing to the balance, daily loss and drawdown, and the tool still said
// COMPLIANT with the profit target reached.
//
// The tool keeps the /evaluate route's math for the sized closes, and now
// counts the unsized ones, names them in a warning (the loss limits cannot be
// confirmed), and does not call the profit target reached while an unsized
// losing close is left out.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/assistant/__qa__/propFirmToolUnsizedTruth.test.ts
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const rows = new Map<unknown, unknown[]>();
function chain(): Record<string, unknown> {
  let table: unknown = null;
  let limit: number | null = null;
  const q: Record<string, unknown> = {};
  q.from = (t: unknown) => { table = t; return q; };
  q.where = () => q; q.orderBy = () => q; q.groupBy = () => q;
  q.limit = (n: number) => { limit = n; return q; };
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
    const all = rows.get(table) ?? [];
    return Promise.resolve(limit == null ? all : all.slice(0, limit)).then(resolve, reject);
  };
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain() } },
});

const { getPropFirmModeStatus } = await import("../tools.js");

const STARTED = new Date(Date.now() - 3 * 86_400_000);
const CHALLENGE = {
  id: 9, userId: 7, paperAccountId: 1, status: "ACTIVE", challengeName: "Test", failureReason: null,
  startedAt: STARTED, createdAt: STARTED,
  startingBalance: 10_000, profitTarget: 0.004, maxDailyLoss: 0.05, maxTotalDrawdown: 0.1,
  minTradingDays: 1, maxTradingDays: 30, consistencyRulePercent: 1,
  trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.1, trailingDrawdownType: "STATIC",
  maxRiskPerTrade: 0.02, maxOpenTrades: 5, maxPendingOrders: 5, maxPositionSize: 10,
  newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 1, strictGuardrailsEnabled: 0,
};
const closedAt = new Date(Date.now() - 86_400_000);
function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", lotSize: 0.5,
    entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.101, exitPrice: 1.101, profitLoss: 50,
    status: "CLOSED_TP", openedAt: closedAt, closedAt, ...over,
  };
}
// A V75 BUY closed by hand 10 points below entry: a loss the venue could not size (stored 0).
const unsizedV75Loss = order({
  id: 2, symbol: "V75", lotSize: 1, entryPrice: 1000, stopLoss: 980, takeProfit: 1040,
  exitPrice: 990, profitLoss: 0, status: "CLOSED_MANUAL",
});

beforeEach(() => {
  rows.clear();
  rows.set(database.propChallengesTable, [CHALLENGE]);
});

type Status = {
  ruleStatus: string; warnings: string[];
  progress: { totalPnl: number; profitTargetReached: boolean; closedTradeCount: number; unsizedClosedTradeCount: number; unsizedSymbols: string[] };
};

test("sized closes only: COMPLIANT with the profit target reached, and no unsized close", async () => {
  rows.set(database.paperOrdersTable, [order({})]);
  const s = await getPropFirmModeStatus(7) as unknown as Status;
  assert.equal(s.ruleStatus, "COMPLIANT");
  assert.equal(s.progress.totalPnl, 50);
  assert.equal(s.progress.profitTargetReached, true);
  assert.equal(s.progress.unsizedClosedTradeCount, 0);
});

test("an unsized manual V75 loss (stored 0) is disclosed: a warning, not COMPLIANT, and the profit target not confirmed", async () => {
  rows.set(database.paperOrdersTable, [order({}), unsizedV75Loss]);
  const s = await getPropFirmModeStatus(7) as unknown as Status;
  assert.equal(s.progress.closedTradeCount, 2);
  assert.equal(s.progress.unsizedClosedTradeCount, 1);
  assert.deepEqual(s.progress.unsizedSymbols, ["V75"]);
  assert.equal(s.progress.totalPnl, 50, "the sized closes' P&L; the unsized amount is not known");
  const w = s.warnings.join("\n");
  assert.match(w, /1 closed paper trade \(V75\) could not be sized/);
  assert.match(w, /left out of the balance, profit, daily loss and drawdown/);
  assert.match(w, /limits cannot be confirmed/);
  assert.equal(s.ruleStatus, "WARNING", "was COMPLIANT while the loss was left out");
  assert.equal(s.progress.profitTargetReached, false, "was true: the unsized loss could take the profit below the target");
});

test("an unsized WIN does not hold back the profit target (leaving it out can only understate the profit)", async () => {
  rows.set(database.paperOrdersTable, [order({}), { ...unsizedV75Loss, exitPrice: 1010, status: "CLOSED_TP" }]);
  const s = await getPropFirmModeStatus(7) as unknown as Status;
  assert.equal(s.progress.unsizedClosedTradeCount, 1);
  assert.equal(s.progress.profitTargetReached, true);
  assert.equal(s.ruleStatus, "WARNING", "the figures still leave a close out");
});
