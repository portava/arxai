// GET /api/ai/coach-summary — the coach summarises the caller's own Trade
// Journal rows. Those rows are typed in by the trader (real, demo or paper
// trades, plus WAIT notes that are not trades at all); nothing ties them to
// the simulator. The response must name the journal as its source and must
// not call the rows "simulated trades", count WAIT notes as trades, or
// invent a confidence calibration from a constant.
//
// Only the database handle is stubbed; the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/aiCoachJournalSource.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let rows: unknown[] = [];
const database = await import("@workspace/db");
function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const { default: express } = await import("express");
const { default: router } = await import("../aiBrain.js");

async function coach(): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 44, role: "USER" };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/ai/coach-summary`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function entry(id: number, direction: string, pnl: number | null, symbol = "EURUSD", strategy = "Breakout") {
  return { id, userId: 44, symbol, direction, strategy, entryIdea: "x", pnl, mistakeTag: null, createdAt: new Date() };
}

test("journal-backed summary names the journal, not the simulator", async () => {
  rows = [entry(1, "BUY", 50), entry(2, "SELL", 20), entry(3, "BUY", -10), entry(4, "WAIT", null)];
  const c = await coach();
  assert.notEqual(c["dataSource"], "SIMULATOR");
  assert.equal(c["dataSource"], "JOURNAL");
  const well = String(c["doingWell"]);
  assert.doesNotMatch(well, /simulat/i);
  // Three BUY/SELL rows carry a P/L; the WAIT note is not a trade.
  assert.match(well, /across 3 journal/);
  assert.match(well, /67%/);
  assert.doesNotMatch(String(c["confidenceCalibration"]), /aligns with win rate/);
});

test("empty journal is also labelled as the journal", async () => {
  rows = [];
  const c = await coach();
  assert.equal(c["dataSource"], "JOURNAL");
});

test("journal with no recorded P/L does not report a win rate", async () => {
  rows = [entry(1, "WAIT", null), entry(2, "BUY", null)];
  const c = await coach();
  assert.doesNotMatch(String(c["doingWell"]), /Win rate|winners/);
  assert.match(String(c["doingWell"]), /none with a recorded P\/L.*no win rate/i);
});

test("many journalled trades never invent a confidence alignment", async () => {
  rows = Array.from({ length: 12 }, (_, i) => entry(i + 1, i % 2 ? "BUY" : "SELL", i % 3 ? 10 : -5));
  const c = await coach();
  assert.doesNotMatch(String(c["confidenceCalibration"]), /aligns with win rate/);
  assert.match(String(c["confidenceCalibration"]), /not measured/i);
});
