// GET /api/notifications/digest feeds the "Latest digest" panel on the
// Notification Center, under copy that promises "We never show other users'
// notifications". It used to return the newest notification_digests row — an
// all-users aggregate whose topCritical list carries other users' alert
// titles. The digest a user reads must cover only that user's notifications.
//
// Only the database handle is stubbed; the real router and service run.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/notificationDigestUserScope.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");

const now = Date.now();
function n(id: string, userId: number, severity: string, type: string, title: string) {
  return {
    id: 1, notificationId: id, userId, type, severity, title, message: "m", status: "UNREAD",
    sourceBuild: "LL", actionRequired: severity === "CRITICAL", createdAt: new Date(now - 60_000),
  };
}
const notifications = [
  n("a1", 1, "CRITICAL", "TRADE", "User one stop hit"),
  n("b1", 2, "CRITICAL", "SAFETY", "User two margin call"),
  n("b2", 2, "WARNING", "TRADE", "User two spread wide"),
];
// The persisted all-users digest the old route returned.
const globalDigest = {
  id: 9, digestId: "digest_global", rangeStart: new Date(now - 86_400_000), rangeEnd: new Date(now),
  totalNotifications: 3, criticalCount: 2, warningCount: 1, tradeCount: 2, learningCount: 0, safetyCount: 1,
  summary: { topCritical: [{ id: "a1", title: "User one stop hit" }, { id: "b1", title: "User two margin call" }] },
  createdAt: new Date(now),
};

function chain(): Record<string, unknown> {
  let rows: unknown[] = [];
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = (t: unknown) => {
    rows = t === database.notificationDigestsTable ? [globalDigest] : t === database.notificationsTable ? notifications : [];
    return q;
  };
  q.where = self; q.orderBy = self; q.limit = self; q.groupBy = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const { default: express } = await import("express");
const { default: router } = await import("../notifications.js");

async function digestFor(userId: number): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: userId, role: "USER" };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/notifications/digest`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { digest: Record<string, unknown> };
    return body.digest;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("user 1's digest counts only user 1's notifications", async () => {
  const d = await digestFor(1);
  assert.equal(d["totalNotifications"], 1);
  assert.equal(d["criticalCount"], 1);
  assert.equal(d["scope"], "USER");
  assert.doesNotMatch(JSON.stringify(d), /User two/);
});

test("user 2's digest counts only user 2's notifications", async () => {
  const d = await digestFor(2);
  assert.equal(d["totalNotifications"], 2);
  assert.equal(d["warningCount"], 1);
  assert.doesNotMatch(JSON.stringify(d), /User one/);
});
