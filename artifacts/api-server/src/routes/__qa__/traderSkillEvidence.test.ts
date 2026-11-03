// Trader Skill evidence (routes/traderSkill.ts).
//
//  - A pillar with no evidence (no debriefs, no edge reports ...) was not
//    measured. It still counts as 0 in the total (thin evidence never earns
//    points), but the API says which pillars are unmeasured so the score card
//    shows "no data" instead of a measured-looking 0.
//  - Practice counted every paper order that is not OPEN, so CANCELLED
//    (voided) orders inflated Practice and the sample cap. Only closed
//    (CLOSED_*) orders are practice.
//
// Stubbed: the database handle (per-table rows). The real route runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/traderSkillEvidence.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Row = Record<string, unknown>;
const tables = new Map<unknown, Row[]>();
let storedProfile: Row | null = null;

function selectChain() {
  let rows: Row[] = [];
  const q: Record<string, unknown> = {};
  q.from = (t: unknown) => {
    rows = t === database.traderSkillProfilesTable ? (storedProfile ? [storedProfile] : []) : (tables.get(t) ?? []);
    return q;
  };
  q.where = () => q; q.orderBy = () => q;
  q.limit = async () => rows;
  return q;
}
function insertChain() {
  let values: Row = {};
  const q: Record<string, unknown> = {};
  q.values = (v: Row) => { values = v; return q; };
  q.returning = async () => {
    storedProfile = { id: 1, createdAt: new Date(), updatedAt: new Date(), ...values };
    return [storedProfile];
  };
  q.catch = () => Promise.resolve();
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => selectChain(), insert: () => insertChain() } },
});

const { default: router } = await import("../traderSkill.js");

async function invoke(method: string, path: string): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `missing route ${method} ${path}`);
  let status = 200;
  let out: any;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { out = data; return this; },
  };
  const request = { authUser: { id: 5, role: "TRADER" }, query: {}, params: {}, body: {}, log: { error: () => {}, warn: () => {} } };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body: out };
}

function papers(closed: number, cancelled: number, open = 0): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < closed; i++) rows.push({ id: i, userId: 5, status: i % 2 ? "CLOSED_TP" : "CLOSED_SL" });
  for (let i = 0; i < cancelled; i++) rows.push({ id: 1000 + i, userId: 5, status: "CANCELLED" });
  for (let i = 0; i < open; i++) rows.push({ id: 2000 + i, userId: 5, status: "OPEN" });
  return rows;
}

function reset() {
  tables.clear();
  storedProfile = null;
  for (const t of [
    database.tradeJournalTable, database.postTradeDebriefsTable, database.weeklyPerformanceReviewsTable,
    database.paperOrdersTable, database.tradingRuleViolationsTable, database.edgeDiscoveryReportsTable,
    database.tradePlansTable,
  ]) tables.set(t, []);
}

test("50 paper orders, 10 of them cancelled, no debriefs: practice counts 40 and unmeasured pillars are named", async () => {
  reset();
  tables.set(database.paperOrdersTable, papers(40, 10));
  const { status, body } = await invoke("post", "/skill/calculate");
  assert.equal(status, 200);
  assert.equal(body.signals.closedPapers, 40, "cancelled orders are not practice trades");
  assert.equal(body.profile.practiceScore, 80, "40 closed of the 50 target");
  const unmeasured: string[] = body.unmeasuredPillars;
  assert.ok(Array.isArray(unmeasured));
  for (const k of ["discipline", "execution", "emotional", "consistency", "planning"]) {
    assert.ok(unmeasured.includes(k), `${k} has no evidence`);
  }
  assert.ok(!unmeasured.includes("practice"));
  assert.ok(!unmeasured.includes("risk"), "risk is measured from 40 closed trades");
  // Unmeasured pillars still count 0 in the stored total: no points from no evidence.
  assert.equal(body.profile.disciplineScore, 0);
});

test("GET /skill/profile names the pillars that still have no evidence", async () => {
  reset();
  tables.set(database.paperOrdersTable, papers(40, 10));
  await invoke("post", "/skill/calculate");
  const { body } = await invoke("get", "/skill/profile");
  assert.ok(body.profile);
  assert.ok(body.unmeasuredPillars.includes("discipline"));
});

test("only-cancelled paper orders are no practice and no activity at all", async () => {
  reset();
  tables.set(database.paperOrdersTable, papers(0, 12));
  const { body } = await invoke("post", "/skill/calculate");
  assert.equal(body.signals.closedPapers, 0);
  assert.equal(body.profile.practiceScore, 0);
  assert.ok(body.unmeasuredPillars.includes("risk"));
});

test("suggestions do not score an unmeasured pillar as 0/100", async () => {
  reset();
  tables.set(database.paperOrdersTable, papers(40, 10));
  await invoke("post", "/skill/calculate");
  const { body } = await invoke("get", "/skill/suggestions");
  const discipline = body.suggestions.find((s: any) => s.area === "Discipline");
  assert.ok(discipline, "lowest pillars are suggested first");
  assert.equal(discipline.score, undefined);
  assert.match(discipline.message, /no data yet/i);
  const noEvidence = new Set(["Discipline", "Execution", "Emotional control", "Consistency", "Planning"]);
  for (const s of body.suggestions) {
    if (noEvidence.has(s.area)) assert.equal(s.score, undefined, `${s.area} shown as a measured score`);
  }
});
