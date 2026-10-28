// Trading Readiness counts only the risk locks that would block this trader.
//
// gatherSignals selected risk_locks WHERE is_active with no user filter and no
// end_time filter, so another trader's lock, or this trader's lock whose end
// time had passed, showed "No active risk lock: FAIL — 1 active risk lock(s)",
// a blocker and status LOCKED. The live pipeline scopes locks to
// (user_id = me OR user_id IS NULL) and ignores expired rows
// (activeRiskLockBlockReason), so readiness contradicted the gate and leaked
// that someone else is locked.
//
// Only the database handle and the safety/broker probes are stubbed; the real
// readiness router runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/tradingReadinessRiskLockScope.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const database = await import("@workspace/db");

const ME = 12;
let lockRows: Array<Record<string, unknown>> = [];
let lockWhere: SQL | undefined;

function lock(id: number, userId: number | null, endTime: Date | null, isActive = true): Record<string, unknown> {
  return {
    id, userId, lockType: "DAILY_LOSS_LIMIT", reason: "qa", startTime: new Date(Date.now() - 3600_000),
    endTime, isActive, overrideAllowed: false, relatedTradeId: null, releasedAt: null, releasedBy: null,
    createdAt: new Date(Date.now() - 3600_000),
  };
}

function chain(table: unknown, projected: boolean): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = (w: SQL) => { if (table === database.riskLocksTable) lockWhere = w; return q; };
  q.orderBy = self; q.limit = self; q.groupBy = self;
  const rows = () => table === database.riskLocksTable ? lockRows
    : table === database.economicEventsTable && projected ? [{ n: 0, latest: null }]
    : [];
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: (fields?: unknown) => ({ from: (t: unknown) => chain(t, fields !== undefined) }),
  insert: () => ({ values: () => Promise.resolve(undefined) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const switches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...switches,
    platformStop: async () => ({ engaged: false, sources: [] }),
    readSafetyCorePosture: async () => ({ present: true, readable: true, operationalMode: "LIVE" }),
    stopSourceEngaged: () => false,
  },
});
const brokerHealth = await import("../../lib/brokerHub/brokerHealthState.js");
mock.module("../../lib/brokerHub/brokerHealthState.js", {
  namedExports: { ...brokerHealth, readLatestBrokerHealthLog: async () => null },
});

const { default: express } = await import("express");
const { default: readinessRouter } = await import("../tradingReadiness.js");

type Evaluation = { status: string; blockers: string[]; checklist: Array<{ id: string; status: string; detail: string }> };

async function evaluate(): Promise<Evaluation> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: ME, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(readinessRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/readiness/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { evaluation: Evaluation }).evaluation;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => { lockRows = []; lockWhere = undefined; });

test("another trader's active lock and this trader's expired lock do not lock readiness", async () => {
  lockRows = [
    lock(1, 999, null),                                   // someone else's indefinite lock
    lock(2, ME, new Date(Date.now() - 60_000)),           // mine, end time already passed
    lock(3, ME, null, false),                             // mine, released
  ];
  const ev = await evaluate();
  const safety = ev.checklist.find((c) => c.id === "safety")!;
  assert.notEqual(safety.status, "FAIL", `safety item: ${safety.detail}`);
  assert.doesNotMatch(safety.detail, /risk lock/i);
  assert.ok(!ev.blockers.some((b) => /risk lock/i.test(b)), `blockers: ${ev.blockers.join(" | ")}`);
  assert.notEqual(ev.status, "LOCKED");
});

test("this trader's unexpired lock and a legacy ownerless lock still count, as at the live gate", async () => {
  lockRows = [
    lock(4, ME, new Date(Date.now() + 30 * 60_000)),
    lock(5, null, null),
    lock(6, 999, null),
  ];
  const ev = await evaluate();
  const safety = ev.checklist.find((c) => c.id === "safety")!;
  assert.equal(safety.status, "FAIL");
  assert.match(safety.detail, /\b2 active risk lock/);
  assert.ok(ev.blockers.some((b) => /2 active risk lock/.test(b)));
  assert.equal(ev.status, "LOCKED");
});

test("the risk-lock query itself is scoped to this trader (or ownerless rows) and to unexpired locks", async () => {
  await evaluate();
  assert.ok(lockWhere, "risk_locks was queried with a WHERE clause");
  const { sql, params } = new PgDialect().sqlToQuery(lockWhere!);
  assert.match(sql, /"user_id" = \$\d+/);
  assert.match(sql, /"user_id" is null/i);
  assert.match(sql, /"end_time" is null/i);
  assert.match(sql, /"end_time" > \$\d+/);
  assert.ok(params.includes(ME), "the caller's id is bound");
});
