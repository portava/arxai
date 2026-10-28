// Ruby Memory (AI Performance Command Center) — what the decision and
// learning figures claim.
//
// The real buildCommandCenter and insight generator run; the database handle
// is a table-aware stub and the readiness / live-posture reads are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/performanceCC/__qa__/commandCenterMemoryTruth.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const rows = new Map<unknown, unknown[]>();
const memory = { edges: [] as unknown[] };

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
mock.module("../../learning/scopedMemory.js", {
  namedExports: { listOwnEdges: async () => memory.edges, listOwnMistakes: async () => [] },
});
mock.module("../../readiness/traderReadiness.js", {
  namedExports: { evaluateReadiness: async () => { throw new Error("not under test"); } },
});
mock.module("../../systemHealth/livePosture.js", {
  namedExports: { readAccountLivePosture: async () => ({ state: "UNKNOWN", currentAccountMode: null, plainEnglish: "not under test" }) },
});

const { buildCommandCenter } = await import("../commandCenter.js");

function decision(id: number, over: Record<string, unknown> = {}) {
  return {
    id, userId: 7, symbol: "EURUSD", action: "BUY", shouldTrade: true, confidence: 70, riskScore: 30,
    entryReason: "", invalidationReason: "", tradeWindowStatus: "GOOD", tradeWindowReason: "",
    decisionJson: {}, operationalMode: "PAPER_TRADING", syntheticData: false, createdAt: new Date(),
    ...over,
  };
}
function order(id: number, over: Record<string, unknown> = {}) {
  return {
    id, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", lotSize: 0.01,
    entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, status: "OPEN", openedAt: new Date(),
    closedAt: null, exitPrice: null, profitLoss: 0, decisionId: null, ...over,
  };
}

beforeEach(() => { rows.clear(); memory.edges = []; });

test("an open order's decision is acted on, not 'blocked'; nothing is called a safety-filter block", async () => {
  rows.set(database.tradeDecisionLogsTable, [decision(1), decision(2), decision(3)]);
  rows.set(database.paperOrdersTable, [
    order(10, { status: "OPEN", decisionId: 1 }),
    order(11, { status: "CLOSED_TP", decisionId: 3, closedAt: new Date(), exitPrice: 1.12, profitLoss: 2 }),
  ]);
  const cc = await buildCommandCenter(7) as unknown as {
    aiDecisionStats: Record<string, unknown>; insights: string[];
  };
  const s = cc.aiDecisionStats;
  // Decision 2 has no order; 1 (open) and 3 (closed) were acted on.
  assert.equal(s.tradeCallsWithoutOrder, 1);
  assert.equal(s.tradeCalls, 3);
  assert.equal(s.blockedCount, null, "no safety-filter outcome is recorded per decision");
  assert.match(String(s.blockedCountScope), /not recorded/i);
  assert.equal(s.decisionToTradeRate, 66.67, "the open order counts as a trade");
  assert.equal(s.decisionToWinRate, 100, "win rate is over decisions whose order closed");
  const all = cc.insights.join("\n");
  assert.doesNotMatch(all, /blocked by safety filters/);
  assert.match(all, /1 of 3 AI trade calls/);
});

test("a cancelled order does not make its decision 'acted on'", async () => {
  rows.set(database.tradeDecisionLogsTable, [decision(1)]);
  rows.set(database.paperOrdersTable, [order(10, { status: "CANCELLED", decisionId: 1 })]);
  const cc = await buildCommandCenter(7) as unknown as { aiDecisionStats: Record<string, unknown> };
  assert.equal(cc.aiDecisionStats.tradeCallsWithoutOrder, 1);
  assert.equal(cc.aiDecisionStats.decisionToTradeRate, 0);
});
