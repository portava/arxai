// Trade Plan Builder truth (routes/tradePlans.ts).
//
//  - Editing a validated plan: the stored checklist and AI review describe the
//    values they were computed on. After a save they no longer describe the
//    current plan, so the plan is a DRAFT and the response flags the
//    checklist as out of date (it is kept, not erased, and not called ready).
//
//  - Validate when the news-risk or portfolio-risk check crashes: the route
//    carries on (non-fatal), but those risks were not checked. The checklist
//    must say so (a WARN "could not be checked" item, so readiness is not
//    changed) and the summary / alert must not claim every check passed.
//
//  - "Broker health is CONNECTED" came from the cached platform-wide
//    broker_health_state verdict with no age check (it is only rewritten when
//    an operator runs a health check). A verdict older than the cache's stale
//    window does not describe the connection now: not PASS. The detail says
//    which check it was and when, and that it is the platform bridge, not
//    the trader's own broker account.
//
// Stubbed: the database handle, the permission verdict, the broker health
// cache, news / portfolio risk, the chart cache and alerts. The real route
// and the real checklist domain run. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/tradePlanTruth.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Row = Record<string, unknown>;
let planRow: Row = {};
const updates: Row[] = [];

function selectChain(rows: () => Row[]) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self;
  q.limit = async () => rows();
  q.then = (resolve: (v: Row[]) => unknown) => Promise.resolve(rows()).then(resolve);
  return q;
}
function updateChain() {
  let patch: Row = {};
  const q: Record<string, unknown> = {};
  q.set = (p: Row) => { patch = p; return q; };
  q.where = () => q;
  q.returning = async () => {
    updates.push(patch);
    planRow = { ...planRow, ...patch };
    return [planRow];
  };
  return q;
}
function insertChain() {
  const q: Record<string, unknown> = {};
  q.values = () => q;
  q.returning = async () => [{ id: 99 }];
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return q;
}
const fakeDb = {
  select: () => selectChain(() => [planRow]),
  update: () => updateChain(),
  insert: () => insertChain(),
  transaction: async (fn: (tx: unknown) => unknown) => fn({
    execute: async () => ({ rows: [planRow] }),
    select: () => selectChain(() => [planRow]),
    update: () => updateChain(),
    insert: () => insertChain(),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

mock.module("../permission.js", {
  namedExports: {
    gatherInputsAndEvaluate: async () => ({ verdict: { status: "CLEAR", blockers: [], warnings: [], activeLocks: [] } }),
  },
});
let brokerState: Row | null = null;
mock.module("../../lib/brokerHub/brokerHealthState.js", {
  namedExports: { readBrokerHealthState: async () => brokerState },
});
let newsImpl: (symbol: string) => Promise<unknown> = async () => ({
  result: { blockTrading: false, riskLevel: "LOW", event: null, tradeWarning: null, aiSummary: "" },
});
mock.module("../newsCalendar.js", {
  namedExports: { generateNewsRiskForSymbol: (s: string) => newsImpl(s) },
});
let portfolioImpl: () => Promise<unknown> = async () => ({
  portfolioRiskLevel: "LOW", blockers: [], warnings: [], aiSummary: "",
});
mock.module("../portfolioRisk.js", {
  namedExports: { getLatestPortfolioRiskOrCompute: () => portfolioImpl() },
});
let chartCache: unknown = null;
mock.module("../../lib/data/chart/chartIntelligence.js", {
  namedExports: { getCachedIntelligenceContext: () => chartCache },
});
mock.module("../../lib/alerts/alertManager.js", {
  namedExports: { createAlert: async () => ({}) },
});

const { default: router } = await import("../tradePlans.js");

async function invoke(method: string, path: string, params: Row, body: Row = {}): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `missing route ${method} ${path}`);
  let status = 200;
  let out: any;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { out = data; return this; },
  };
  const request = {
    authUser: { id: 5, role: "TRADER" }, query: {}, params, body,
    log: { warn: () => {}, error: () => {}, info: () => {} },
  };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body: out };
}

const passingChecklist = {
  items: [{ key: "SL_DEFINED", label: "Stop loss is defined", status: "PASS", detail: "1.095" }],
  passCount: 9, failCount: 0, warnCount: 0, isReady: true, rewardToRisk: 2,
};

function plan(patch: Row = {}): Row {
  const t = new Date(Date.now() - 86_400_000);
  return {
    id: 11, userId: 5, signalId: null, symbol: "EURUSD", directionBias: "BUY", strategyId: "breakout",
    marketCondition: "TRENDING", entryConditions: null, invalidationConditions: null,
    stopLossPlan: null, takeProfitPlan: null, entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11,
    lotSize: 0.1, riskAmount: 50, maxLossAllowed: 100, rewardToRiskTarget: 1.5, confidenceLevel: 80,
    status: "READY", aiSummary: "BUY plan on EURUSD. All pre-trade checks pass.",
    checklistJson: passingChecklist, executionConfirmationId: null,
    finalRecommendation: null, marketThesis: "", invalidation: "", managementPlan: "", riskAuditJson: null,
    createdAt: t, updatedAt: t, ...patch,
  };
}

test("editing a READY plan: DRAFT, and the old checklist is flagged out of date, never still ready", async () => {
  planRow = plan({ status: "READY" });
  const { status, body } = await invoke("patch", "/trade-plans/:id", { id: "11" }, { stopLoss: 1.12 });
  assert.equal(status, 200);
  assert.equal(body.status, "DRAFT");
  assert.equal(body.stopLoss, 1.12);
  assert.equal(body.checklistStale, true, "the checklist was computed on the previous values");
});

test("editing an INVALIDATED plan: the failed checklist no longer describes it either", async () => {
  planRow = plan({ status: "INVALIDATED", checklistJson: { ...passingChecklist, isReady: false, failCount: 1 } });
  const { status, body } = await invoke("patch", "/trade-plans/:id", { id: "11" }, { lotSize: 0.05 });
  assert.equal(status, 200);
  assert.equal(body.status, "DRAFT");
  assert.equal(body.checklistStale, true);
});

test("a freshly validated plan's checklist is current and says when it was checked", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date() };
  const { status, body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  assert.equal(status, 200);
  assert.equal(body.checklistStale, false);
  assert.equal(typeof body.checklist.checkedAtIso, "string");
});

test("validate with a crashing news-risk check: READY is unchanged, but the checklist says news was not checked", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date() };
  newsImpl = async () => { throw new Error("calendar table missing"); };
  try {
    const { status, body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
    assert.equal(status, 200);
    assert.equal(body.status, "READY", "a WARN does not change readiness (no gate is moved)");
    const item = body.checklist.items.find((i: any) => i.key === "NEWS_RISK");
    assert.ok(item, "an item says news risk was not checked");
    assert.equal(item.status, "WARN");
    assert.match(item.detail, /could not be checked/i);
    assert.equal(body.checklist.warnCount, body.checklist.items.filter((i: any) => i.status === "WARN").length);
    assert.doesNotMatch(body.aiSummary, /All pre-trade checks pass/);
  } finally {
    newsImpl = async () => ({ result: { blockTrading: false, riskLevel: "LOW", event: null, tradeWarning: null, aiSummary: "" } });
  }
});

test("validate with a crashing portfolio-risk check says portfolio risk was not checked", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date() };
  portfolioImpl = async () => { throw new Error("positions unavailable"); };
  try {
    const { status, body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
    assert.equal(status, 200);
    const item = body.checklist.items.find((i: any) => i.key === "PORTFOLIO_RISK");
    assert.ok(item, "an item says portfolio risk was not checked");
    assert.equal(item.status, "WARN");
    assert.match(item.detail, /could not be checked/i);
    assert.doesNotMatch(body.aiSummary, /All pre-trade checks pass/);
  } finally {
    portfolioImpl = async () => ({ portfolioRiskLevel: "LOW", blockers: [], warnings: [], aiSummary: "" });
  }
});

test("a plan with no symbol was not checked against news risk, and says so", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null, symbol: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date() };
  const { body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  const item = body.checklist.items.find((i: any) => i.key === "NEWS_RISK");
  assert.ok(item);
  assert.equal(item.status, "WARN");
  assert.match(item.detail, /no symbol/i);
});

function brokerItem(body: any) {
  const item = body.checklist.items.find((i: any) => i.key === "BROKER_HEALTH");
  assert.ok(item, "broker health item present");
  return item;
}

test("a CONNECTED verdict evaluated 6 hours ago is not a PASS", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date(Date.now() - 6 * 3_600_000) };
  const { status, body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  assert.equal(status, 200);
  const item = brokerItem(body);
  assert.notEqual(item.status, "PASS");
  assert.equal(item.status, "WARN", "unknown now, so a caution; it does not newly block readiness");
  assert.match(item.detail, /not confirmed/i);
  assert.match(item.detail, /6 hours ago/);
  assert.match(item.detail, /not a check of your own broker account/i);
  assert.equal(body.checklist.passCount, body.checklist.items.filter((i: any) => i.status === "PASS").length);
});

test("a CONNECTED verdict with no evaluation time is not a PASS", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: null };
  const { body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  assert.notEqual(brokerItem(body).status, "PASS");
});

test("a CONNECTED verdict from a moment ago passes and says where it came from", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "CONNECTED", lastEvaluatedAt: new Date(Date.now() - 30_000) };
  const { body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  const item = brokerItem(body);
  assert.equal(item.status, "PASS");
  assert.match(item.detail, /platform broker health check/i);
});

test("a stale DISCONNECTED verdict still fails", async () => {
  planRow = plan({ status: "DRAFT", checklistJson: null });
  brokerState = { executionEnabled: true, lastStatus: "DISCONNECTED", lastEvaluatedAt: new Date(Date.now() - 6 * 3_600_000) };
  const { body } = await invoke("post", "/trade-plans/:id/validate", { id: "11" });
  assert.equal(brokerItem(body).status, "FAIL");
  assert.equal(body.status, "INVALIDATED");
});
