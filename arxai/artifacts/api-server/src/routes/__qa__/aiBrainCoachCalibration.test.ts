// The AI Coach (GET /ai/coach-summary) is built from the caller's
// trade_journal rows, which record symbol, strategy, pnl and a mistake tag --
// no confidence score.
//
// Locks the inaccuracy: with >= 10 entries the coach said "Average confidence
// aligns with win rate within N pts", where N was |winRate - 60| -- a literal
// 60 standing in for a confidence average that is never recorded or read.
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

const SCHEMA = "../../../../../lib/db/src/schema/tradeJournal.ts";

test("the journal schema has no confidence column (so nothing can be calibrated)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL(SCHEMA, import.meta.url)), "utf8");
  assert.doesNotMatch(src, /confidence/i);
});

test("coach-summary does not claim a confidence/win-rate alignment it never measured", async () => {
  // 12 entries, 9 winners -> winRate 75 (old copy: "within 15 pts").
  journal = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, pnl: i < 9 ? 10 : -5 }));
  const body = await get("/ai/coach-summary");
  const c = String(body["confidenceCalibration"]);
  assert.doesNotMatch(c, /aligns|within \d+ pts/i, `fabricated calibration: ${c}`);
  assert.match(c, /not measured/i);
  assert.match(c, /do not record a confidence/i);
});

test("a small journal gets the same honest statement, not 'not yet calibrated'", async () => {
  journal = [row({ id: 1, pnl: 10 }), row({ id: 2, pnl: -5 })];
  const body = await get("/ai/coach-summary");
  assert.match(String(body["confidenceCalibration"]), /not measured/i);
});
