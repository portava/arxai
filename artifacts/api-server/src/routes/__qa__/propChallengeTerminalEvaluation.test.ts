// POST /prop-challenges/:id/evaluate kept re-evaluating finished challenges.
// The page posts it every 8 s for the latest challenge, so a PASSED challenge
// went on adding paper trades closed after it ended, its day count grew
// without bound (a "TIME_LIMIT HARD Day 45 > maxTradingDays 30" violation
// appeared under the PASSED banner), its stored day and violation rows were
// rewritten, and prop-firm notifications were sent for cancelled challenges.
//
// A finished challenge (PASSED, FAILED, CANCELED) is now judged only on what
// happened up to its end: trades closed after completedAt are left out, the
// day count stops at completedAt, rules about positions open now are not
// applied, and the evaluation is read-only (no stored rows rewritten, no
// notifications). Active challenges evaluate exactly as before.
//
// The database and notifier are stubbed; the real route runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/propChallengeTerminalEvaluation.test.ts

import { after, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const DAY = 86_400_000;
type Row = Record<string, unknown>;
const T = (name: string) => ({ __table: name });
const tables = {
  propChallengesTable: T("challenges"),
  propChallengeDaysTable: T("days"),
  propChallengeViolationsTable: T("violations"),
  paperAccountsTable: T("accounts"),
  paperOrdersTable: T("orders"),
  vaultEventsTable: T("vault"),
};
let challenge: Row = {};
let orders: Row[] = [];
const writes: Array<{ op: string; table: string }> = [];
const notified: unknown[] = [];

function rowsFor(t: { __table: string }): Row[] {
  if (t.__table === "challenges") return [challenge];
  if (t.__table === "orders") return orders;
  return [];
}
function query(rows: () => Row[]) {
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: async () => rows(),
    then: (ok: (v: Row[]) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, err),
  };
  return q;
}
function writeOp(op: string, t: { __table: string }) {
  writes.push({ op, table: t.__table });
  const done = Promise.resolve([]);
  const w = {
    where: () => done,
    values: () => Object.assign(Promise.resolve([]), { returning: async () => [] }),
    set: () => ({ where: () => done }),
  };
  return w;
}
mock.module("@workspace/db", {
  namedExports: {
    db: {
      select: () => ({ from: (t: { __table: string }) => query(() => rowsFor(t)) }),
      insert: (t: { __table: string }) => writeOp("insert", t),
      delete: (t: { __table: string }) => writeOp("delete", t),
      update: (t: { __table: string }) => writeOp("update", t),
    },
    ...tables,
  },
});
mock.module("drizzle-orm", {
  namedExports: {
    and: (...a: unknown[]) => a, asc: (c: unknown) => c, desc: (c: unknown) => c, eq: () => true,
    sql: () => ({}),
  },
});
mock.module("../../lib/auth/middleware.js", {
  namedExports: { requireUser: (_req: unknown, _res: unknown, next: () => void) => next() },
});
mock.module("../../lib/notifications/service.js", {
  namedExports: { notify: async (n: unknown) => { notified.push(n); } },
});

const { default: propChallengesRouter } = await import("../propChallenges.js");

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 7 };
    (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", propChallengesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { writes.length = 0; notified.length = 0; });

function baseChallenge(over: Row): Row {
  const now = Date.now();
  return {
    id: 1, userId: 7, paperAccountId: 3, challengeName: "c", startingBalance: 10_000,
    profitTarget: 0.10, maxDailyLoss: 0.05, maxTotalDrawdown: 0.10, minTradingDays: 1,
    maxTradingDays: 30, consistencyRulePercent: 1, status: "ACTIVE", failureReason: null,
    startedAt: new Date(now - 45 * DAY), completedAt: null, updatedAt: new Date(now - 25 * DAY),
    trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
    maxRiskPerTrade: 1, maxOpenTrades: 1, maxPendingOrders: 100, maxPositionSize: 100,
    newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 0,
    strictGuardrailsEnabled: 0,
    ...over,
  };
}
function order(id: number, closedDaysAgo: number | null, profitLoss: number): Row {
  const now = Date.now();
  return {
    id, userId: 7, paperAccountId: 3, status: closedDaysAgo == null ? "OPEN" : "CLOSED",
    openedAt: new Date(now - ((closedDaysAgo ?? 3) + 1) * DAY),
    closedAt: closedDaysAgo == null ? null : new Date(now - closedDaysAgo * DAY),
    profitLoss, lotSize: 0.1,
  };
}
type EvalBody = { summary: Record<string, unknown>; violations: Array<{ type: string; severity: string; message: string }> };
async function evaluate(): Promise<EvalBody> {
  const r = await fetch(`${base}/prop-challenges/1/evaluate`, { method: "POST" });
  assert.equal(r.status, 200);
  return await r.json() as EvalBody;
}

test("a PASSED challenge is judged up to completedAt: later trades and days are left out", async () => {
  // Started 45 days ago, passed on day 20 (25 days ago) with +$1,100.
  const now = Date.now();
  challenge = baseChallenge({ status: "PASSED", startedAt: new Date(now - 45 * DAY), completedAt: new Date(now - 25 * DAY) });
  orders = [order(1, 30, 1_100), order(2, 5, -400), order(3, null, 0), order(4, null, 0)];
  const body = await evaluate();
  assert.equal(body.summary["status"], "PASSED");
  assert.equal(body.summary["totalPnl"], 1_100, "a trade closed after the challenge ended is not counted");
  assert.equal(body.summary["tradeCount"], 1);
  assert.equal(body.summary["daysSinceStart"], 20, "the day count stops at completedAt");
  const types = body.violations.map((v) => v.type);
  assert.ok(!types.includes("TIME_LIMIT"), `no time-limit violation after the end: ${types.join(",")}`);
  assert.ok(!types.includes("MAX_OPEN_TRADES"), "positions open now are not judged against a finished challenge");
  assert.ok(!types.includes("OVERNIGHT_RESTRICTION"));
  assert.equal(body.summary["final"], true);
  assert.equal(body.summary["evaluatedThrough"], (challenge["completedAt"] as Date).toISOString());
});

test("a finished challenge's evaluation is read-only: no stored rows rewritten, no notifications", async () => {
  challenge = baseChallenge({ status: "CANCELED", completedAt: new Date(Date.now() - 25 * DAY) });
  orders = [order(1, 30, -600), order(2, 5, -900), order(3, null, 0), order(4, null, 0)];
  await evaluate();
  assert.deepEqual(writes, [], "no day/violation/status rows written for a cancelled challenge");
  assert.equal(notified.length, 0, "no prop-firm notifications for a cancelled challenge");
});

test("an ACTIVE challenge still evaluates every trade and day up to now", async () => {
  challenge = baseChallenge({ status: "ACTIVE", startedAt: new Date(Date.now() - 10 * DAY + 60_000), maxOpenTrades: 100 });
  orders = [order(1, 8, 200), order(2, 1, 300)];
  const body = await evaluate();
  assert.equal(body.summary["totalPnl"], 500);
  assert.equal(body.summary["daysSinceStart"], 10);
  assert.equal(body.summary["final"], false);
  assert.ok(writes.some((w) => w.op === "insert" && w.table === "days"), "active evaluation still stores its day rows");
});
