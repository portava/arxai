// Truth: an edge slice's "AI edge summary" behaviour scores must describe
// that slice. They were averaged over ALL of the user's debriefs (identical
// on every slice) and stored as 0 with no debriefs, shown as
// "Discipline 0 · Execution 0 · Emotional 0". Now: scores come from debriefs
// linked to the slice's own trades; with none the report says "not measured"
// (warning + summary + behaviourBasis on the detail read).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const router = (await import("../edgeDiscovery.js")).default;

const paper = (id: number, symbol: string, pnl: number) => ({
  id, userId: 7, symbol, direction: "BUY", status: "CLOSED", profitLoss: pnl,
  entryPrice: 1, exitPrice: 1, stopLoss: null, takeProfit: null,
});
const debrief = (tradeId: number, followedPlan: number, emotion: string) => ({
  id: tradeId + 500, userId: 7, tradeId, followedPlan, traderEmotionAfter: emotion,
});

async function post(rows: FakeRows) {
  fake = createFakeDb(rows);
  let body: { reports: Array<Record<string, unknown>> } = { reports: [] };
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/edge/reports`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupBy: "symbol" }),
    });
    assert.equal(r.status, 200);
    body = await r.json() as typeof body;
  });
  return { reports: body.reports, inserts: fake.inserts };
}

test("journal-only slices with zero debriefs are marked not measured, not scored 0", async () => {
  const { reports, inserts } = await post({
    trade_journal: [
      { id: 1, userId: 7, symbol: "EURUSD", strategy: "A", direction: "BUY", emotionTag: null, pnl: 5 },
      { id: 2, userId: 7, symbol: "GBPUSD", strategy: "A", direction: "BUY", emotionTag: null, pnl: -3 },
    ],
  });
  assert.equal(reports.length, 2);
  for (const r of reports) {
    assert.equal(r["behaviourBasis"], "NOT_MEASURED");
    assert.match(String(r["aiSummary"]), /Behaviour scores: not measured/);
  }
  const warnings = inserts.filter((i) => i.table === "edge_warnings" && i.values["warningType"] === "BEHAVIOUR_NOT_MEASURED");
  assert.equal(warnings.length, 2);
});

test("behaviour scores are per slice, from debriefs on that slice's trades", async () => {
  const { reports } = await post({
    paper_orders: [paper(10, "EURUSD", 4), paper(11, "EURUSD", -2), paper(20, "XAUUSD", 6)],
    post_trade_debriefs: [debrief(10, 1, "CALM"), debrief(11, 1, "CALM"), debrief(20, 0, "ANXIOUS")],
  });
  const eur = reports.find((r) => r["symbol"] === "EURUSD")!;
  const xau = reports.find((r) => r["symbol"] === "XAUUSD")!;
  assert.equal(eur["disciplineScoreAvg"], 100);
  assert.equal(eur["emotionalScoreAvg"], 100);
  assert.equal(xau["disciplineScoreAvg"], 0);
  assert.equal(xau["emotionalScoreAvg"], 0);
  assert.equal(eur["behaviourBasis"], "SLICE_DEBRIEFS");
  assert.equal(xau["behaviourBasis"], "SLICE_DEBRIEFS");
  assert.match(String(eur["aiSummary"]), /from 2 post-trade debriefs on trades in this slice/);
});

test("detail read reports the behaviour basis of a stored report", async () => {
  fake = createFakeDb({
    edge_discovery_reports: [{ id: 9, userId: 7, edgeName: "symbol=EURUSD", aiSummary: "EURUSD: not enough data yet.", disciplineScoreAvg: 0, executionScoreAvg: 0, emotionalScoreAvg: 0 }],
    edge_warnings: [{ id: 1, userId: 7, edgeReportId: 9, warningType: "BEHAVIOUR_NOT_MEASURED", message: "x", severity: "INFO" }],
  });
  await withRouter(router, { id: 7 }, async (base) => {
    const body = await (await fetch(`${base}/edge/reports/9`)).json() as Record<string, unknown>;
    assert.equal(body["behaviourBasis"], "NOT_MEASURED");
  });
  fake = createFakeDb({
    edge_discovery_reports: [{ id: 9, userId: 7, edgeName: "symbol=EURUSD", aiSummary: "EURUSD: not enough data yet.", disciplineScoreAvg: 40, executionScoreAvg: 45, emotionalScoreAvg: 50 }],
    edge_warnings: [],
  });
  await withRouter(router, { id: 7 }, async (base) => {
    const body = await (await fetch(`${base}/edge/reports/9`)).json() as Record<string, unknown>;
    assert.equal(body["behaviourBasis"], "ACCOUNT_WIDE_LEGACY");
  });
});
