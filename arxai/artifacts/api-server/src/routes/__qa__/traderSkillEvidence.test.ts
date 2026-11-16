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

// Round 3 review: GET /skill/profile judged a stored profile's pillars against
// TODAY's evidence. A profile calculated with no debriefs stores Discipline 0
// (not measured); once debriefs were written (without Recalculate) discipline
// had evidence now, dropped off the unmeasured list, and the card showed the
// stored, never-measured 0 as a measured score. Unmeasured is now worked out
// as of the snapshot, and pillars with evidence since are named.
const past = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);

function datedPapers(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i, userId: 5, status: "CLOSED_TP", createdAt: past(120), closedAt: past(90),
  }));
}

test("a pillar with no evidence at the snapshot stays 'no data' after evidence arrives, and is named as having new evidence", async () => {
  reset();
  tables.set(database.paperOrdersTable, datedPapers(40));
  await invoke("post", "/skill/calculate");
  assert.equal(storedProfile!.disciplineScore, 0, "no debriefs when calculated");
  // Debriefs written after the snapshot; no Recalculate.
  const later = new Date((storedProfile!.createdAt as Date).getTime() + 60_000);
  tables.set(database.postTradeDebriefsTable, [
    { id: 1, userId: 5, followedPlan: 1, traderEmotionAfter: "CALM", checklist: [{ answer: "YES" }], createdAt: later },
  ]);
  const { body } = await invoke("get", "/skill/profile");
  assert.ok(body.unmeasuredPillars.includes("discipline"), "the stored 0 was never measured, whatever today's evidence");
  assert.ok(body.unmeasuredPillars.includes("emotional"));
  assert.ok(body.unmeasuredPillars.includes("execution"));
  assert.deepEqual([...body.unmeasuredPillarsWithNewEvidence].sort(), ["discipline", "emotional", "execution", "planning"].sort());
  assert.ok(!body.unmeasuredPillarsWithNewEvidence.includes("consistency"), "still no edge reports");

  const sug = await invoke("get", "/skill/suggestions");
  const discipline = sug.body.suggestions.find((s: any) => s.area === "Discipline");
  assert.ok(discipline);
  assert.equal(discipline.score, undefined, "a never-measured 0 is not a score");
  assert.match(discipline.message, /recalculate/i);
});

test("evidence that existed when the profile was calculated is measured, not 'no data'", async () => {
  reset();
  tables.set(database.paperOrdersTable, datedPapers(40));
  tables.set(database.postTradeDebriefsTable, [
    { id: 1, userId: 5, followedPlan: 0, traderEmotionAfter: "ANXIOUS", checklist: [{ answer: "NO" }], createdAt: past(60) },
  ]);
  await invoke("post", "/skill/calculate");
  assert.equal(storedProfile!.disciplineScore, 0, "a measured 0: the plan was not followed");
  const { body } = await invoke("get", "/skill/profile");
  assert.ok(!body.unmeasuredPillars.includes("discipline"), "measured at the snapshot");
  assert.deepEqual(body.unmeasuredPillarsWithNewEvidence, []);
});

// Round 3 review (p2-exec): Emotional control counted as measured whenever
// any debrief existed, even when none recorded an emotion. The automatic
// debrief written on every paper close records no emotion, so a trader who
// never tagged one saw a measured-looking 0 for Emotional control while
// Analytics said "no data". It is now measured only when a debrief recorded
// an emotion, as Analytics reads it.
test("debriefs with no recorded emotion leave Emotional control unmeasured; one recorded emotion measures it", async () => {
  reset();
  tables.set(database.paperOrdersTable, datedPapers(20));
  const auto = (id: number, emotion: unknown) => ({
    id, userId: 5, followedPlan: 1, traderEmotionAfter: emotion, checklist: [], createdAt: past(60),
  });
  tables.set(database.postTradeDebriefsTable, [auto(1, null), auto(2, null), auto(3, "")]);
  const { body } = await invoke("post", "/skill/calculate");
  assert.equal(body.signals.debriefCount, 3);
  assert.equal(body.profile.emotionalControlScore, 0);
  assert.ok(body.unmeasuredPillars.includes("emotional"), "no debrief recorded an emotion");
  assert.ok(!body.unmeasuredPillars.includes("discipline"), "discipline reads every debrief's followed-plan flag");
  const profile = await invoke("get", "/skill/profile");
  assert.ok(profile.body.unmeasuredPillars.includes("emotional"));
  const sug = await invoke("get", "/skill/suggestions");
  const emo = sug.body.suggestions.find((s: any) => s.area === "Emotional control");
  assert.ok(emo, "the lowest pillars are suggested");
  assert.equal(emo.score, undefined, "an unmeasured 0 is not a score");
  assert.match(emo.message, /no data yet/i);

  reset();
  tables.set(database.paperOrdersTable, datedPapers(20));
  tables.set(database.postTradeDebriefsTable, [auto(1, null), auto(2, "ANXIOUS")]);
  const measured = await invoke("post", "/skill/calculate");
  assert.equal(measured.body.profile.emotionalControlScore, 0, "a measured 0: the one recorded emotion was not calm");
  assert.ok(!measured.body.unmeasuredPillars.includes("emotional"));
});
