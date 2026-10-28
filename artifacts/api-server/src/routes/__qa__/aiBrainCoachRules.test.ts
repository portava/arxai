// The AI Coach (GET /ai/coach-summary) is built from the caller's
// trade_journal rows, which record symbol, strategy, pnl and a mistake tag --
// no setupQualityScore, marketBias or riskRewardRatio.
//
// Locks the inaccuracy: "Suggested rule changes" under the personalised
// "Recommended focus next session" card were three constant strings,
// identical for every journal, citing fields the journal does not hold.
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

test("coach rule suggestions come from the caller's journal, not a constant list", async () => {
  journal = [
    row({ id: 1, pnl: -40, strategy: "breakout", mistakeTag: "CHASED_ENTRY" }),
    row({ id: 2, pnl: -15, strategy: "breakout", mistakeTag: "CHASED_ENTRY" }),
    row({ id: 3, pnl: 30, strategy: "pullback" }),
  ];
  const a = await get("/ai/coach-summary");
  journal = [
    row({ id: 4, pnl: 12, strategy: "range", symbol: "XAUUSD", mistakeTag: "MOVED_STOP" }),
    row({ id: 5, pnl: -60, strategy: "news", symbol: "USDJPY" }),
  ];
  const b = await get("/ai/coach-summary");

  const ra = a["suggestedRuleChanges"] as string[];
  const rb = b["suggestedRuleChanges"] as string[];
  assert.notDeepEqual(ra, rb, "different journals must not produce the same suggestions");
  for (const r of [...ra, ...rb]) {
    assert.doesNotMatch(r, /setupQualityScore|marketBias|riskRewardRatio/,
      `"${r}" cites a field the journal does not record`);
  }
  assert.ok(ra.some((r) => r.includes("CHASED_ENTRY") && /2 /.test(r)), `mistake rule cites the observed count: ${JSON.stringify(ra)}`);
  assert.ok(ra.some((r) => r.includes("breakout")), `losing strategy is named: ${JSON.stringify(ra)}`);
  assert.ok(rb.some((r) => r.includes("news")), `losing strategy is named: ${JSON.stringify(rb)}`);
});

test("a journal with no repeated mistake and no losing strategy yields no rule suggestions", async () => {
  journal = [row({ id: 1, pnl: 10 }), row({ id: 2, pnl: 20, mistakeTag: "LATE_EXIT" })];
  const body = await get("/ai/coach-summary");
  assert.deepEqual(body["suggestedRuleChanges"], []);
});
