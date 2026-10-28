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

function edge(id: number, edgeScore: number, signalName = `sig${id}`, netPnl = 0) {
  return { id, symbol: "EURUSD", strategyName: signalName, signalName, action: "BUY", edgeScore, netPnl, updatedAt: new Date("2026-10-01T00:00:00Z") };
}
function closedOrders(n: number) {
  return Array.from({ length: n }, (_, i) => order(100 + i, { status: "CLOSED_TP", closedAt: new Date(), exitPrice: 1.12, profitLoss: 2 }));
}

test("Improvement Score with too few edges is not computed (null), not 0.00", async () => {
  memory.edges = [edge(1, 10), edge(2, 0)];
  const cc = await buildCommandCenter(7) as unknown as { learningStats: Record<string, unknown> };
  assert.equal(cc.learningStats.improvementScore, null);
  assert.match(String(cc.learningStats.improvementScoreBasis), /not measured/i);
});

test("current edge scores ordered by id are not a trend: no improvement/declining claim", async () => {
  memory.edges = [edge(1, 10), edge(2, 10), edge(3, 0), edge(4, 0)];
  rows.set(database.paperOrdersTable, closedOrders(12));
  const cc = await buildCommandCenter(7) as unknown as {
    overallStatus: string; learningStats: Record<string, unknown>; insights: string[]; nextBestActions: string[];
  };
  assert.equal(cc.learningStats.improvementScore, null);
  assert.notEqual(cc.overallStatus, "IMPROVING");
  assert.notEqual(cc.overallStatus, "DECLINING");
  assert.notEqual(cc.overallStatus, "STABLE", "stable is also a claim about change over time");
  const text = [...cc.insights, ...cc.nextBestActions].join("\n");
  assert.doesNotMatch(text, /improvement/i);
  assert.doesNotMatch(text, /declining/i);
});

test("Best/Weakest setup says its P&L sums overlap across signals", async () => {
  memory.edges = [edge(1, 5, "trend", 10), edge(2, 5, "session", 10)];
  const cc = await buildCommandCenter(7) as unknown as Record<string, unknown>;
  assert.match(String(cc.setupRankingBasis), /counts toward each/i);
});
