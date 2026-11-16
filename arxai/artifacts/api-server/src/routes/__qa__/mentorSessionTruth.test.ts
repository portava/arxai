// Truth: the AI mentor must not present historical rows as today's state.
// A HARD rule violation from months ago is not "a risk warning raised" now,
// and a stored LOCKED readiness row from weeks ago is not "you are LOCKED out
// by the safety system" (the live lock lives in the risk governor).
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let rows: FakeRows = {};
let fake = createFakeDb(rows);
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const router = (await import("../aiMentor.js")).default;

const DAY = 86_400_000;
function setRows(next: FakeRows) { rows = next; fake = createFakeDb(rows); }
beforeEach(() => setRows({}));

async function generate(body: Record<string, unknown>) {
  let session: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/mentor/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    session = (await r.json() as { session: Record<string, unknown> }).session;
  });
  return session;
}

test("a 90-day-old HARD violation does not auto-detect a RISK_WARNING session", async () => {
  setRows({
    trading_rule_violations: [{
      id: 1, userId: 7, contractId: 1, tradeId: null, violationType: "DAILY_LOSS",
      severity: "HARD", message: "Daily loss cap exceeded", createdAt: new Date(Date.now() - 90 * DAY),
    }],
  });
  const s = await generate({});
  assert.notEqual(s["sessionType"], "RISK_WARNING");
  assert.doesNotMatch(String(s["mentorMessage"]), /A risk warning was raised/);
});

test("a requested RISK_WARNING on an old violation says when it was recorded", async () => {
  setRows({
    trading_rule_violations: [{
      id: 1, userId: 7, contractId: 1, tradeId: null, violationType: "DAILY_LOSS",
      severity: "HARD", message: "Daily loss cap exceeded", createdAt: new Date(Date.now() - 90 * DAY),
    }],
  });
  const s = await generate({ sessionType: "RISK_WARNING" });
  const msg = String(s["mentorMessage"]);
  assert.doesNotMatch(msg, /A risk warning was raised based on/);
  assert.match(msg, /90 days ago/);
});

test("a fresh HARD violation still auto-detects RISK_WARNING and states its age", async () => {
  setRows({
    trading_rule_violations: [{
      id: 2, userId: 7, contractId: 1, tradeId: null, violationType: "OVER_RISK",
      severity: "HARD", message: "Risk per trade above contract", createdAt: new Date(Date.now() - 2 * 3_600_000),
    }],
  });
  const s = await generate({});
  assert.equal(s["sessionType"], "RISK_WARNING");
  assert.match(String(s["mentorMessage"]), /2 hours ago/);
});

test("a 30-day-old stored LOCKED readiness row does not claim 'you are LOCKED out' now", async () => {
  setRows({
    trading_readiness_checks: [{ id: 3, userId: 7, status: "LOCKED", createdAt: new Date(Date.now() - 30 * DAY) }],
  });
  const auto = await generate({});
  assert.notEqual(auto["sessionType"], "DISCIPLINE_CHECK");
  const asked = await generate({ sessionType: "DISCIPLINE_CHECK" });
  const msg = String(asked["mentorMessage"]);
  assert.doesNotMatch(msg, /you are LOCKED out by the safety system/i);
  assert.match(msg, /30 days ago/);
});

test("a same-day stored LOCKED row is described as a stored check, not the live lock", async () => {
  setRows({
    trading_readiness_checks: [{ id: 4, userId: 7, status: "LOCKED", createdAt: new Date(Date.now() - 3_600_000) }],
  });
  const s = await generate({});
  assert.equal(s["sessionType"], "DISCIPLINE_CHECK");
  const msg = String(s["mentorMessage"]);
  assert.doesNotMatch(msg, /you are LOCKED out by the safety system/i);
  assert.match(msg, /readiness check recorded 1 hour ago came back LOCKED/i);
});
