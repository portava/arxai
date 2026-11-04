// Regression: importing candles without a marketCondition stored the scenario
// as "RANGING". Nothing computed that from the candles; it was a default, and
// the Replay Simulator then showed it as the scenario's market condition. An
// import with no condition is now stored as "UNSPECIFIED"; a condition the
// caller supplies is kept as given.
//
// The database is a stub that records inserts. The real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/replayImportConditionUnmeasured.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const inserted: Array<Record<string, unknown>> = [];
const fakeDb = {
  insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { default: express } = await import("express");
const { default: router } = await import("../replay.js");

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const candles = Array.from({ length: 10 }, (_, i) => ({ t: Date.UTC(2026, 0, 1) + i * 60_000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1 }));

test("an import with no marketCondition is UNSPECIFIED, not a defaulted RANGING", async () => {
  const res = await post("/replay/scenarios", { candles, symbol: "EURUSD" });
  assert.equal(res.status, 200);
  const scenario = res.json["scenario"] as { marketCondition: string; source: string };
  assert.equal(scenario.source, "IMPORTED");
  assert.equal(scenario.marketCondition, "UNSPECIFIED");
  assert.equal(inserted.at(-1)?.marketCondition, "UNSPECIFIED");
});

test("an import with a marketCondition keeps the caller's label", async () => {
  const res = await post("/replay/scenarios", { candles, symbol: "EURUSD", marketCondition: "TRENDING_DOWN" });
  assert.equal(res.status, 200);
  assert.equal((res.json["scenario"] as { marketCondition: string }).marketCondition, "TRENDING_DOWN");
});
