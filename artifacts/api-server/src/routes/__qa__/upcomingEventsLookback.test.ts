// Regression: GET /economic-events/upcoming filtered eventTime >= now, so the
// scanner's High-impact event banner vanished the moment a release happened —
// exactly while the Truth news window (radar state LIVE, up to 30 min after the
// release) still reports highImpactWindowActive. The route now takes an
// optional pastMinutes look-back (default 0 keeps every other caller as-is) and
// stamps checkedAt on the response.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

let lastWhere: SQL | undefined;
const fakeDb = {
  select: () => ({
    from: () => ({
      where: (cond: SQL) => {
        lastWhere = cond;
        return { orderBy: async () => [] };
      },
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
const { default: router } = await import("../newsCalendar.js");

async function invoke(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/economic-events/upcoming");
  assert.ok(layer, "missing route");
  let status = 200;
  let body: any;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { body = data; return this; },
  };
  const request = { query, params: {}, log: { error: () => {} } };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body };
}

function sinceMs(): number {
  assert.ok(lastWhere, "no where clause captured");
  const { params } = new PgDialect().sqlToQuery(lastWhere);
  const first = params[0];
  const d = first instanceof Date ? first : new Date(String(first));
  return d.getTime();
}

test("pastMinutes=30 keeps events released in the last 30 minutes in the window", async () => {
  const before = Date.now();
  const { status, body } = await invoke({ hours: "1", minImpact: "HIGH", pastMinutes: "30" });
  assert.equal(status, 200);
  const since = sinceMs();
  assert.ok(since <= before - 30 * 60_000 + 1_000, `since should be ~30 min ago, got ${(before - since) / 60_000} min`);
  assert.ok(since >= before - 30 * 60_000 - 5_000);
  assert.equal(body.pastMinutes, 30);
  assert.equal(typeof body.checkedAt, "string");
});

test("default look-back stays at now for existing callers", async () => {
  const before = Date.now();
  await invoke({ hours: "1", minImpact: "HIGH" });
  const since = sinceMs();
  assert.ok(Math.abs(since - before) < 5_000);
});
