// Truth: GET /performance/scorecard names a "best" symbol only when it is net
// profitable and a "worst" only when net losing (never the same symbol), and
// the mistake distribution lists real mistakes only — untagged rows and the
// "None" tag are not a mistake pattern.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const router = (await import("../aiBrain.js")).default;

type Row = { symbol?: string; pnl: number | null; mistakeTag?: string | null; direction?: string };
function journal(list: Row[]): FakeRows {
  return {
    trade_journal: list.map((r, i) => ({
      id: i + 1, userId: 7, symbol: r.symbol ?? "EURUSD", direction: r.direction ?? "BUY",
      strategy: "Trend Continuation", entryIdea: "idea", actualOutcome: null, pnl: r.pnl,
      emotionTag: null, mistakeTag: r.mistakeTag ?? null, lessonLearned: null, screenshotUrl: null,
      createdAt: new Date(),
    })),
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

test("one losing symbol is not 'best'; untagged rows are not a 'none' mistake", async () => {
  const s = await get("/performance/scorecard", journal([{ pnl: -5 }, { pnl: -5 }, { pnl: -5 }]));
  assert.equal(s["bestSymbol"], null);
  assert.equal(s["worstSymbol"], "EURUSD");
  assert.deepEqual(s["mistakeDistribution"], {});
});

test("one winning symbol is 'best' but not also 'worst'", async () => {
  const s = await get("/performance/scorecard", journal([{ pnl: 4 }, { pnl: 2 }]));
  assert.equal(s["bestSymbol"], "EURUSD");
  assert.equal(s["worstSymbol"], null);
});

test("the explicit 'None' mistake tag is not listed as a mistake; real tags are", async () => {
  const s = await get("/performance/scorecard", journal([
    { pnl: 1, mistakeTag: "None" }, { pnl: -1, mistakeTag: "Early Entry" }, { pnl: -2, mistakeTag: "Early Entry" },
  ]));
  assert.deepEqual(s["mistakeDistribution"], { "Early Entry": 2 });
});

test("rows without a P&L do not rank a symbol", async () => {
  const s = await get("/performance/scorecard", journal([
    { symbol: "GBPUSD", pnl: null }, { symbol: "XAUUSD", pnl: -3 },
  ]));
  assert.equal(s["bestSymbol"], null);
  assert.equal(s["worstSymbol"], "XAUUSD");
});

test("coach: the 'None' tag is not reported as the most common mistake", async () => {
  const s = await get("/ai/coach-summary", journal([{ pnl: 1, mistakeTag: "None" }, { pnl: 2, mistakeTag: "None" }]));
  assert.equal(s["mostCommonMistake"], "none");
  assert.doesNotMatch(String(s["doingPoorly"]), /Most common mistake/);
});
