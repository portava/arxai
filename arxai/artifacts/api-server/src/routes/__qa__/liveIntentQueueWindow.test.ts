// GET /live-intent/queue computes its counts over the newest `limit` intents
// only (default 100). The page showed them as totals. The response now says
// which window the counts cover (limit) and whether older intents exist
// beyond it (hasMore), from one extra row read. Counts are unchanged.
//
// The database and broker reads are stubbed; the real route runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveIntentQueueWindow.test.ts

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

let stored: Array<Record<string, unknown>> = [];
const limitsAsked: number[] = [];
const col = (name: string) => ({ name });
mock.module("@workspace/db", {
  namedExports: {
    db: {
      select: () => ({
        from: () => ({
          orderBy: () => ({
            limit: async (n: number) => { limitsAsked.push(n); return stored.slice(0, n); },
          }),
        }),
      }),
    },
    liveIntentsTable: { createdAt: col("created_at"), intentId: col("intent_id") },
    vaultEventsTable: {},
  },
});
mock.module("drizzle-orm", { namedExports: { desc: (c: unknown) => c, eq: () => true } });
mock.module("../../lib/broker/secrets.js", { namedExports: { selectBrokerKind: () => "none" } });
mock.module("../../lib/broker/registry.js", { namedExports: { getBrokerProvider: () => ({ status: async () => ({ connected: false }) }) } });

const { default: liveIntentRouter } = await import("../liveIntent.js");

const intent = (i: number, status: string) => ({ id: i, intentId: `i-${i}`, status, createdAt: new Date(Date.now() - i * 1000).toISOString() });

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 1, role: "ADMIN" }; next(); });
  app.use("/api", liveIntentRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test("more than 100 intents: counts cover the newest 100 and hasMore says older intents exist", async () => {
  stored = Array.from({ length: 130 }, (_, i) => intent(i, i % 2 ? "REJECTED_BY_RISK" : "PENDING_MT5_CONNECTION"));
  const r = await fetch(`${base}/live-intent/queue`);
  assert.equal(r.status, 200);
  const body = await r.json() as { intents: unknown[]; counts: Record<string, number>; limit: number; hasMore: boolean };
  assert.equal(body.intents.length, 100);
  assert.equal(body.counts.total, 100);
  assert.equal(body.counts.rejected, 50);
  assert.equal(body.limit, 100);
  assert.equal(body.hasMore, true);
  assert.equal(limitsAsked.at(-1), 101);
});

test("exactly 100 intents: the window holds them all (hasMore false)", async () => {
  stored = Array.from({ length: 100 }, (_, i) => intent(i, "PENDING_MT5_CONNECTION"));
  const body = await (await fetch(`${base}/live-intent/queue`)).json() as { counts: Record<string, number>; hasMore: boolean };
  assert.equal(body.counts.total, 100);
  assert.equal(body.hasMore, false);
});

test("an explicit limit is the window reported", async () => {
  stored = Array.from({ length: 30 }, (_, i) => intent(i, "PENDING_MT5_CONNECTION"));
  const body = await (await fetch(`${base}/live-intent/queue?limit=20`)).json() as { intents: unknown[]; limit: number; hasMore: boolean };
  assert.equal(body.intents.length, 20);
  assert.equal(body.limit, 20);
  assert.equal(body.hasMore, true);
});
