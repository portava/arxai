// Truth: GET /ai/coach-summary reports a win rate over trades with a known
// outcome only. WAIT entries are decisions not to trade and rows without a
// P&L have no outcome yet; neither is a loss. Best/worst strategy and the
// "Stop trading X" advice must not name a profitable (or the only) strategy.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
const router = (await import("../aiBrain.js")).default;

type Row = { symbol?: string; direction?: string; strategy?: string; pnl: number | null; mistakeTag?: string | null };
function journal(list: Row[]): FakeRows {
  return {
    trade_journal: list.map((r, i) => ({
      id: i + 1, userId: 7, symbol: r.symbol ?? "EURUSD", direction: r.direction ?? "BUY",
      strategy: r.strategy ?? "Trend Continuation", entryIdea: "idea", actualOutcome: null,
      pnl: r.pnl, emotionTag: null, mistakeTag: r.mistakeTag ?? null, lessonLearned: null,
      screenshotUrl: null, createdAt: new Date(),
    })),
  };
}
async function coach(rows: FakeRows): Promise<Record<string, unknown>> {
  fake = createFakeDb(rows);
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/ai/coach-summary`);
    assert.equal(r.status, 200);
    body = await r.json() as Record<string, unknown>;
  });
  return body;
}

test("win rate counts only trades with a recorded outcome (WAIT and no-P&L rows excluded)", async () => {
  const s = await coach(journal([
    { pnl: 10 }, { pnl: 5 }, { pnl: 3 }, { pnl: 1 },
    { direction: "WAIT", pnl: null }, { direction: "WAIT", pnl: null },
    { pnl: null }, { pnl: null },
  ]));
  const well = String(s["doingWell"]);
  assert.doesNotMatch(well, /50%/);
  assert.doesNotMatch(well, /across 8/);
  assert.match(well, /Win rate 100% across 4 simulated trades with a recorded result/);
  assert.match(well, /4 journal entries/);
  assert.equal(s["winRate"], 100);
  assert.equal(s["tradesWithOutcome"], 4);
  assert.equal(s["entriesWithoutOutcome"], 4);
});

test("no recorded outcomes: no win rate is invented", async () => {
  const s = await coach(journal([{ direction: "WAIT", pnl: null }, { pnl: null }]));
  assert.equal(s["winRate"], null);
  assert.doesNotMatch(String(s["doingWell"]), /0 winners|Win rate \d/);
  assert.match(String(s["doingWell"]), /no win rate/i);
});

test("confidence calibration is not claimed from a hard-coded constant", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 12; i++) rows.push({ pnl: i % 2 ? 4 : -2 });
  const s = await coach(journal(rows));
  assert.doesNotMatch(String(s["confidenceCalibration"]), /aligns with win rate within/);
});

test("one profitable strategy is not also 'worst', and gets no 'Stop trading' advice", async () => {
  const s = await coach(journal([{ pnl: 10 }, { pnl: 5 }, { pnl: 2 }]));
  assert.equal(s["bestStrategy"], "Trend Continuation");
  assert.equal(s["worstStrategy"], null);
  assert.equal(s["bestSymbol"], "EURUSD");
  assert.equal(s["weakestSymbol"], null);
  assert.doesNotMatch(String(s["recommendedFocus"]), /Stop trading/);
});

test("a strategy with no recorded outcomes is not ranked as 'best' (null P&L is not 0)", async () => {
  const s = await coach(journal([
    { strategy: "Mean Reversion", symbol: "GBPUSD", pnl: null }, { strategy: "Mean Reversion", symbol: "GBPUSD", pnl: null },
    { strategy: "Breakout", symbol: "XAUUSD", pnl: -4 },
  ]));
  assert.equal(s["bestStrategy"], null);
  assert.equal(s["bestSymbol"], null);
  assert.equal(s["worstStrategy"], "Breakout");
  assert.equal(s["weakestSymbol"], "XAUUSD");
  assert.match(String(s["recommendedFocus"]), /Stop trading "Breakout"/);
});

test("all strategies losing: no 'best' strategy is named", async () => {
  const s = await coach(journal([{ pnl: -3 }, { pnl: -2 }]));
  assert.equal(s["bestStrategy"], null);
  assert.equal(s["bestSymbol"], null);
  assert.equal(s["worstStrategy"], "Trend Continuation");
});
