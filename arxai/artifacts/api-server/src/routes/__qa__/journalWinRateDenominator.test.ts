// Truth: GET /performance/scorecard (headline + JOURNAL bucket) and GET
// /learning/performance divided wins by EVERY journal row. A WAIT row or an
// entry with no P&L is not a loss, so 2 wins + 2 unrecorded rows read 50%,
// /learning/performance counted every non-win row as a loss, and a journal
// with no decided trade read 0%.
//
// Now the denominator is decided trades (BUY/SELL rows with a recorded win or
// loss) and the win rate is null when there are none.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const router = (await import("../aiBrain.js")).default;

type Row = { pnl: number | null; direction?: string };
function journal(list: Row[]): FakeRows {
  return {
    trade_journal: list.map((r, i) => ({
      id: i + 1, userId: 7, symbol: "EURUSD", direction: r.direction ?? "BUY",
      strategy: "Trend Continuation", entryIdea: "idea", actualOutcome: null, pnl: r.pnl,
      emotionTag: null, mistakeTag: null, lessonLearned: null, screenshotUrl: null,
      createdAt: new Date(),
    })),
    learning_insights: [],
  };
}
async function get(path: string, rows: FakeRows): Promise<Record<string, unknown>> {
  fake = createFakeDb(rows);
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200);
    body = await r.json() as Record<string, unknown>;
  });
  return body;
}

const MIXED = journal([
  { pnl: 10 }, { pnl: 5 }, { pnl: -4 },
  { pnl: null }, { pnl: null, direction: "WAIT" }, { pnl: 0, direction: "WAIT" },
]);

test("scorecard: 2 wins, 1 loss and 3 undecided rows is a 67% win rate, not 33%", async () => {
  const s = await get("/performance/scorecard", MIXED);
  const headline = s["headline"] as Record<string, unknown>;
  assert.equal(headline["winRate"], 67);
  assert.equal(headline["tradesDecided"], 3);
  assert.equal(headline["totalTrades"], 6);
  const bucket = (s["environments"] as Record<string, Record<string, unknown>>)["JOURNAL"]!;
  assert.equal(bucket["winRate"], 67);
  assert.equal(bucket["wins"], 2);
  assert.equal(bucket["losses"], 1);
});

test("scorecard: no decided trade means no win rate (null), not 0%", async () => {
  const s = await get("/performance/scorecard", journal([{ pnl: null }, { pnl: 0 }]));
  assert.equal((s["headline"] as Record<string, unknown>)["winRate"], null);
});

test("/learning/performance: losses are recorded losses and the win rate is over decided trades", async () => {
  const s = await get("/learning/performance", MIXED);
  assert.equal(s["wins"], 2);
  assert.equal(s["losses"], 1);
  assert.equal(s["winRate"], 67);
  assert.equal(s["tradesDecided"], 3);
  assert.notEqual(s["dataSource"], "SIMULATOR");
});

test("/learning/performance: no decided trade means a null win rate", async () => {
  const s = await get("/learning/performance", journal([{ pnl: null }]));
  assert.equal(s["winRate"], null);
  assert.equal(s["losses"], 0);
});
