// The Win/Loss Report (GET /performance/scorecard) is built from ONE source:
// the caller's trade_journal rows, a table with no environment column.
//
// Locks the inaccuracy: the footer said "Data source:
// SIMULATOR_AND_TESTER_INTENTS" and the Environment Separation table filed
// every journal row under "PAPER", beside a "DEMO_SIMULATOR: 0 trades" row
// for a table the handler never read.
//
// Offline: the REAL router runs on loopback; only db.select is replaced so it
// answers with fixture journal rows (no database is contacted).

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";

type JournalRow = {
  id: number; userId: number; symbol: string; direction: string; strategy: string;
  entryIdea: string; actualOutcome: string | null; pnl: number | null;
  emotionTag: string | null; mistakeTag: string | null; lessonLearned: string | null;
  screenshotUrl: string | null; createdAt: Date;
};

let journal: JournalRow[] = [];
const selects: number[] = [];

function chain(resolve: () => Promise<unknown>): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => resolve().then(a, b);
      if (prop === "catch") return (b: (e: unknown) => unknown) => resolve().catch(b);
      if (prop === "finally") return (f: () => void) => resolve().finally(f);
      return () => chain(resolve);
    },
  };
  return new Proxy(() => undefined, handler);
}

mock.method(db, "select", () => {
  selects.push(1);
  return chain(async () => journal);
});

const { default: router } = await import("../aiBrain.js");

function row(over: Partial<JournalRow>): JournalRow {
  return {
    id: 1, userId: 9, symbol: "EURUSD", direction: "BUY", strategy: "breakout",
    entryIdea: "idea", actualOutcome: null, pnl: 0, emotionTag: null, mistakeTag: null,
    lessonLearned: null, screenshotUrl: null, createdAt: new Date("2026-10-20T10:00:00Z"),
    ...over,
  };
}

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 9 };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>;
}

test("scorecard names trade_journal as its only source and does not file entries under PAPER", async () => {
  journal = [
    row({ id: 1, pnl: 25 }),
    row({ id: 2, pnl: -10, symbol: "GBPUSD" }),
    row({ id: 3, pnl: 5, strategy: "pullback" }),
  ];
  selects.length = 0;
  const body = await get("/performance/scorecard");
  assert.equal(selects.length, 1, "the scorecard reads exactly one table");
  assert.notEqual(body["dataSource"], "SIMULATOR_AND_TESTER_INTENTS");
  assert.equal(body["dataSource"], "TRADE_JOURNAL");

  const envs = body["environments"] as Record<string, Record<string, unknown>>;
  assert.equal(envs["PAPER"], undefined, "journal rows carry no environment, so no PAPER bucket");
  const journalBucket = envs["JOURNAL"];
  assert.ok(journalBucket, "all journal entries are reported in one JOURNAL bucket");
  assert.equal(journalBucket["trades"], 3);
  assert.equal(journalBucket["wins"], 2);
  assert.equal(journalBucket["losses"], 1);
  assert.match(String(journalBucket["note"]), /no environment/i);

  // Sources the handler never read must not show a measured zero.
  for (const [name, v] of Object.entries(envs)) {
    if (name === "JOURNAL") continue;
    assert.equal(v["trades"], null, `${name} was not read, so its trade count is unknown (got ${JSON.stringify(v["trades"])})`);
    assert.match(String(v["note"] ?? v["status"]), /not read|never executed/i);
  }
  assert.doesNotMatch(JSON.stringify(envs), /stored in paper-execution table/);
});
