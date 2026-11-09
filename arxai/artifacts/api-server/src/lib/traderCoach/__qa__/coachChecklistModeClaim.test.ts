// The Trader Coach pre-session checklist (shown on /trader-coach) carried an
// auto-ticked item "Mode is PAPER_ONLY (no live execution attempted)". The
// coach never reads the account mode, and an armed LIVE_SHARED trader is not
// in PAPER_ONLY mode (the dashboard's Trading Permission card says "Live
// trading is active"). The item now states only what the coach knows: it
// sends no orders.
//
// Only the database handle is stubbed (empty book); the real generator runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/traderCoach/__qa__/coachChecklistModeClaim.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve([]).then(resolve, reject);
  return q;
}
function writer(): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  const self = () => w;
  w.values = self; w.set = self; w.where = self; w.onConflictDoNothing = self; w.onConflictDoUpdate = self;
  w.returning = async () => [];
  w.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return w;
}
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: { select: () => chain(), insert: () => writer(), update: () => writer(), execute: async () => ({ rows: [] }) },
  },
});

const { generateCoachReport } = await import("../coach.js");

test("no auto-ticked checklist item asserts the account's mode", async () => {
  const r = await generateCoachReport({ userId: 7, reportType: "DAILY", persist: false });
  for (const item of r.preSessionChecklist) {
    assert.doesNotMatch(item.label, /PAPER_ONLY|mode is paper/i, item.id);
  }
  const noOrders = r.preSessionChecklist.find((i) => i.id === "paper_only");
  assert.ok(noOrders, "the no-live-execution item is kept (same id)");
  assert.match(noOrders.label, /sends no orders/i);
});
