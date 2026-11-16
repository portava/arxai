// Truth regression: Autopilot status tiles and decision scores.
//
// Before: "Trades remaining" counted only AI_AUTO orders while the MAX_TRADES
// rule counts every non-manual order today, so an approved AI_ASSIST order
// left the page saying "1 remaining" while the next scan was rejected with
// MAX_TRADES. Decisions carried mock scores (price drift) and simulated news
// with nothing saying so.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/autopilotStatusTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

type QaOrder = { orderId: string; source: string; createdAt: string; symbol: string; direction: string; status: string; environment: string };
const orders: QaOrder[] = [];

mock.module("../marketScanner.js", { namedExports: { pushDecision: () => undefined } });
mock.module("../oms.js", { namedExports: {
  placeOrder: async (input: { source: string; symbol: string; direction: string; environment: string }) => {
    const o: QaOrder = {
      orderId: `ord_qa_${orders.length + 1}`, source: input.source, createdAt: new Date().toISOString(),
      symbol: input.symbol, direction: input.direction, status: "APPROVED_FOR_SIMULATION", environment: input.environment,
    };
    orders.unshift(o);
    return { order: o, governance: { allowed: true, blockedBy: [], reason: null, auditEventId: null } };
  },
  fillOrder: async () => ({ ok: true, value: {}, governance: { allowed: true, blockedBy: [], reason: null, auditEventId: null } }),
  listOrders: () => [...orders],
  listPositions: () => [],
  pnlSummary: () => ({ dailyPnL: 0, weeklyPnL: 0 }),
} });

const ap = await import("../autopilot.js");

test("Trades remaining counts what the MAX_TRADES rule counts (an approved AI_ASSIST order uses the cap)", async () => {
  const s = ap.startSession({ name: "qa", mode: "AI_ASSIST", requireApproval: true, rules: { symbols: ["EURUSD"], maxTrades: 1 } });
  assert.ok(!("error" in s), JSON.stringify(s));
  try {
    assert.equal(ap.status().dailyTradesRemaining, 1);
    // An operator approves one AI_ASSIST decision: the OMS books an AI_ASSIST order.
    orders.unshift({
      orderId: "ord_qa_assist", source: "AI_ASSIST", createdAt: new Date().toISOString(),
      symbol: "EURUSD", direction: "BUY", status: "FILLED_SIMULATOR", environment: "DEMO_SIMULATOR",
    });
    const st = ap.status();
    assert.equal(st.tradesCountedToday, 1);
    assert.equal(st.dailyTradesRemaining, 0, "the MAX_TRADES rule counts every non-manual order, so the cap is used up");

    const d = await ap.runDecisionPipeline({ force: true, symbol: "EURUSD", actorUserId: 1 });
    if ("error" in d) assert.fail(d.error);
    if (!d.rulesFailed.includes("NO_DATA")) {
      assert.ok(d.rulesFailed.includes("MAX_TRADES"), "the pipeline refuses with MAX_TRADES, as the tile says");
    }
  } finally {
    ap.stopSession();
    orders.length = 0;
  }
});

test("a manual order does not use the trade cap, on the tile or in the rule", () => {
  orders.unshift({
    orderId: "ord_qa_manual", source: "MANUAL", createdAt: new Date().toISOString(),
    symbol: "EURUSD", direction: "BUY", status: "FILLED_SIMULATOR", environment: "DEMO_SIMULATOR",
  });
  const s = ap.startSession({ name: "qa", mode: "OBSERVE_ONLY", rules: { symbols: ["EURUSD"], maxTrades: 1 } });
  assert.ok(!("error" in s));
  try {
    assert.equal(ap.status().tradesCountedToday, 0);
    assert.equal(ap.status().dailyTradesRemaining, 1);
  } finally {
    ap.stopSession();
    orders.length = 0;
  }
});

test("status says its book is every simulator user and how many decisions discipline rests on", () => {
  const st = ap.status();
  assert.equal(st.bookScope, "ALL_SIMULATOR_USERS");
  assert.equal(typeof st.disciplineDecisions, "number");
});

test("each decision says its scores are simulated and where its news came from", async () => {
  const s = ap.startSession({ name: "qa", mode: "OBSERVE_ONLY", rules: { symbols: ["EURUSD"] } });
  assert.ok(!("error" in s));
  try {
    const d = await ap.runDecisionPipeline({ force: true, symbol: "EURUSD" });
    if ("error" in d) assert.fail(d.error);
    assert.equal(d.scoreBasis, "SIMULATED_PRICE_DRIFT");
    assert.equal(d.newsBasis, "SIMULATOR_NEWS_LIST");
    assert.match(d.newsDetail, /not a live economic calendar/);
    assert.ok(ap.status().disciplineDecisions >= 1);
  } finally {
    ap.stopSession();
  }
});
