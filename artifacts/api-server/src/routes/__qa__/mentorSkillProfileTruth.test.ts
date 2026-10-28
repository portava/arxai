// Truth: with no trader skill profile (POST /skill/calculate never run) the
// mentor must not print default scores as if measured — no "Beginner
// (0/100)", "score is at 0", or "last week your weakest area was ... (0/100)".
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

test("no skill profile: no invented 'Beginner (0/100)' or 'score is at 0'", async () => {
  for (const sessionType of ["DAILY_BRIEFING", "CONFIDENCE_REBUILD", "WEEKLY_RESET", "POST_TRADE_GUIDANCE"]) {
    const s = await generate({ sessionType });
    const msg = `${String(s["mainFocus"])} ${String(s["mentorMessage"])}`;
    assert.doesNotMatch(msg, /\(0\/100\)|score is at 0|Beginner/, `${sessionType}: ${msg}`);
    assert.notEqual(s["skillLevel"], "Beginner", sessionType);
    assert.doesNotMatch(msg, /Last week your weakest area/, sessionType);
  }
  const daily = await generate({ sessionType: "DAILY_BRIEFING" });
  assert.match(String(daily["mentorMessage"]), /No skill profile has been calculated yet/);
});

test("with a measured profile the scores are still shown", async () => {
  setRows({
    trader_skill_profiles: [{
      id: 1, userId: 7, skillLevel: "Intermediate", totalScore: 61.4,
      disciplineScore: 55, executionScore: 70, riskScore: 66, emotionalControlScore: 62,
      consistencyScore: 58, planningScore: 64, reviewScore: 60, practiceScore: 52,
      updatedAt: new Date(Date.now() - 3 * DAY),
    }],
  });
  const s = await generate({ sessionType: "DAILY_BRIEFING" });
  assert.match(String(s["mentorMessage"]), /Intermediate \(61\/100, skill profile calculated 3 days ago\)/);
  assert.equal(s["skillLevel"], "Intermediate");
});
