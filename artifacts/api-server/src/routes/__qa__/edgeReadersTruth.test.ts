// Truth: every reader of edge reports shows the edge board's current picture.
//
// The edge board (GET /edge/*) shows only the newest generation of each slice
// and re-derives legacy rows written before the no-losses marker fix (PF 999,
// STRONG_EDGE, saturated confidence) to what the stored numbers support. The
// AI mentor and the trade-decision edge signal read the raw table instead:
// the mentor named a legacy "PF 999" slice as the strength to lean into, an
// old STRONG_EDGE generation contradicted the slice's current NO_EDGE row in
// the same briefing, and the trade decision gave that marker row an edge PASS.
//
// Offline: the REAL mentor router and the REAL trade-decision helper run over
// an in-memory db fake. No database, no broker, no network.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const mentorRouter = (await import("../aiMentor.js")).default;
const { readEdgeSignal } = await import("../tradeDecision.js");

function setRows(rows: FakeRows) { fake = createFakeDb(rows); }
beforeEach(() => setRows({}));

function report(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, edgeName: "symbol=EURUSD", symbol: "EURUSD", sessionName: null,
    marketCondition: null, timeframe: null, strategyId: null,
    sampleSize: 12, winRate: 1, averageRr: 0, expectancy: 5, profitFactor: 2,
    disciplineScoreAvg: 0, executionScoreAvg: 0, emotionalScoreAvg: 0,
    confidenceScore: 60, status: "DEVELOPING_EDGE", aiSummary: "",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

// Written before the marker fix: 12 all-winning trades stored as PF 999,
// STRONG_EDGE, confidence 100. The edge board shows it as DEVELOPING_EDGE.
const LEGACY_MARKER = report({
  id: 1, profitFactor: 999, status: "STRONG_EDGE", confidenceScore: 100,
  aiSummary: "EURUSD: a measurable historical edge (PF 999.00, win rate 100%, 12 trades).",
});

// Two generations of one slice: an old STRONG_EDGE run, then today's NO_EDGE.
const OLD_STRONG = report({
  id: 2, edgeName: "symbol=GBPUSD", symbol: "GBPUSD", sampleSize: 40, winRate: 0.6,
  expectancy: 4, profitFactor: 2, status: "STRONG_EDGE", confidenceScore: 90,
  createdAt: new Date("2026-09-01T00:00:00Z"),
});
const NEW_NO_EDGE = report({
  id: 3, edgeName: "symbol=GBPUSD", symbol: "GBPUSD", sampleSize: 45, winRate: 0.3,
  expectancy: -6, profitFactor: 0.5, status: "NO_EDGE", confidenceScore: 45,
  createdAt: new Date("2026-10-20T00:00:00Z"),
});

async function briefing(): Promise<Record<string, unknown>> {
  let session: Record<string, unknown> = {};
  await withRouter(mentorRouter, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/mentor/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionType: "DAILY_BRIEFING" }),
    });
    assert.equal(r.status, 200);
    session = (await r.json() as { session: Record<string, unknown> }).session;
  });
  return session;
}

test("mentor: a legacy PF 999 STRONG_EDGE row is named as a developing edge, not a proven strength", async () => {
  setRows({ edge_discovery_reports: [LEGACY_MARKER] });
  const s = await briefing();
  const text = `${s["mainFocus"]} ${s["mentorMessage"]}`;
  assert.match(text, /symbol=EURUSD \(a developing edge, not yet proven\)/);
  assert.doesNotMatch(text, /Lean into symbol=EURUSD\./);
});

test("mentor: an old STRONG_EDGE generation is not today's strength when the slice is now NO_EDGE", async () => {
  setRows({ edge_discovery_reports: [OLD_STRONG, NEW_NO_EDGE] });
  const s = await briefing();
  const text = `${s["mainFocus"]} ${s["mentorMessage"]}`;
  assert.doesNotMatch(text, /Lean into symbol=GBPUSD/);
  assert.doesNotMatch(text, /One strength to lean into: symbol=GBPUSD/);
  assert.match(text, /NO measurable edge on symbol=GBPUSD/);
});

test("mentor: a WEAK_EDGE slice is called a weak edge, not 'NO measurable edge'", async () => {
  setRows({ edge_discovery_reports: [report({ id: 4, status: "WEAK_EDGE", expectancy: 0.5, profitFactor: 1.05, confidenceScore: 40 })] });
  const s = await briefing();
  assert.match(String(s["mentorMessage"]), /only a weak edge on symbol=EURUSD/);
  assert.doesNotMatch(String(s["mentorMessage"]), /NO measurable edge/);
});

test("trade decision: the legacy PF 999 row does not give an edge PASS", async () => {
  setRows({ edge_discovery_reports: [LEGACY_MARKER] });
  const { signal, warning } = await readEdgeSignal(7, "EURUSD");
  assert.notEqual(signal.status, "PASS");
  assert.match(signal.detail, /DEVELOPING_EDGE/);
  assert.doesNotMatch(signal.detail, /conf=100/);
  assert.ok(warning);
});

test("trade decision: an old STRONG_EDGE generation does not pass when the slice is now NO_EDGE", async () => {
  setRows({ edge_discovery_reports: [OLD_STRONG, NEW_NO_EDGE] });
  const { signal, warning } = await readEdgeSignal(7, "GBPUSD");
  assert.equal(signal.status, "WARN");
  assert.equal(signal.score, 0);
  assert.match(signal.detail, /NO_EDGE/);
  assert.match(String(warning), /no measurable edge/i);
});

test("trade decision: a current measured STRONG_EDGE still passes; no report is MISSING", async () => {
  setRows({ edge_discovery_reports: [OLD_STRONG] });
  const strong = await readEdgeSignal(7, "GBPUSD");
  assert.equal(strong.signal.status, "PASS");
  assert.equal(strong.signal.score, 9);
  assert.equal(strong.warning, null);
  const none = await readEdgeSignal(7, "USDJPY");
  assert.equal(none.signal.status, "MISSING");
});
