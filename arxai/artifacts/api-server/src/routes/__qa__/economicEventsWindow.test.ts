// GET /api/economic-events is the Economic Calendar page's fallback when no
// live provider is connected. Its window was always [now, now + days*24h]:
//   - "Today" could never show events already released earlier today, so the
//     page's Total Events undercounted and Recent Event Reactions was empty;
//   - the page has to know that the window is rolling hours, not calendar days.
// An additive `pastHours` (0..48, default 0) lets the page ask for the part of
// today that has already passed. Default behaviour is unchanged.
//
// Only the database handle is stubbed; the real router runs and the real
// drizzle conditions are rendered to SQL params to read the window. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/economicEventsWindow.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let lastWhere: SQL | undefined;
const database = await import("@workspace/db");
function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.orderBy = self; q.limit = self; q.groupBy = self;
  q.where = (cond: SQL) => { lastWhere = cond; return q; };
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const { default: express } = await import("express");
const { default: router } = await import("../newsCalendar.js");

async function get(path: string): Promise<number> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { error: () => undefined, warn: () => undefined, info: () => undefined };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    await res.text();
    return res.status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The two time bounds the route put in its WHERE clause, as epoch ms. */
function windowBounds(): [number, number] {
  assert.ok(lastWhere, "route issued a query");
  const { params } = new PgDialect().sqlToQuery(lastWhere);
  const times = params
    .map((p) => (p instanceof Date ? p.getTime() : typeof p === "string" ? Date.parse(p) : NaN))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  assert.equal(times.length, 2, `two time bounds, got ${JSON.stringify(params)}`);
  return [times[0]!, times[1]!];
}

test("default window is unchanged: now .. now + days", async () => {
  const before = Date.now();
  assert.equal(await get("/economic-events?days=1"), 200);
  const [since, until] = windowBounds();
  assert.ok(since >= before - 1000 && since <= Date.now() + 1000, "starts at now");
  assert.ok(Math.abs(until - since - 86_400_000) < 2000, "ends 24h later");
});

test("pastHours reaches back so events released earlier today can be listed", async () => {
  const before = Date.now();
  assert.equal(await get("/economic-events?days=1&pastHours=9"), 200);
  const [since, until] = windowBounds();
  assert.ok(Math.abs(since - (before - 9 * 3_600_000)) < 2000, "starts 9h ago");
  assert.ok(Math.abs(until - (before + 86_400_000)) < 2000, "still ends 24h from now");
});

test("pastHours is bounded (no unbounded history reads)", async () => {
  assert.equal(await get("/economic-events?days=1&pastHours=500"), 400);
});
