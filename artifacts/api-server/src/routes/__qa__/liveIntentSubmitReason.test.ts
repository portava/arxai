// Live intent submit: the reason must describe the verdict actually reached.
//
// The defect this locks: whenever the risk checks passed the route said "MT5
// bridge is not connected yet", even when it had just read mt5Connected=true
// and returned READY_FOR_BROKER_WHEN_CONNECTED. Only the DB handle and the
// broker status lookup are stubbed; the real router runs. No network, no
// broker call, and the route still never places an order.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/liveIntentSubmitReason.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
const inserts: unknown[] = [];
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: {
      insert: () => ({
        values: (v: unknown) => { inserts.push(v); return { returning: async () => [{ id: inserts.length, ...(v as object) }] }; },
      }),
    },
  },
});

let mt5Connected = false;
const secrets = await import("../../lib/broker/secrets.js");
mock.module("../../lib/broker/secrets.js", {
  namedExports: { ...secrets, selectBrokerKind: () => "mt5" },
});
const registry = await import("../../lib/broker/registry.js");
mock.module("../../lib/broker/registry.js", {
  namedExports: {
    ...registry,
    getBrokerProvider: () => ({ status: async () => ({ connected: mt5Connected }) }),
  },
});

const express = (await import("express")).default;
const router = (await import("../liveIntent.js")).default;

async function submit(body: Record<string, unknown>): Promise<Record<string, any>> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 1, role: "USER" }; next(); });
  app.use("/api", router);
  const server: Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/live-intent/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, any>;
  } finally {
    server.close();
  }
}

const valid = { source: "AI_ASSIST", symbol: "EURUSD", direction: "BUY", lotSize: 0.01, stopLoss: 1.09, takeProfit: 1.12, maxLossUsd: 5 };

beforeEach(() => { inserts.length = 0; mt5Connected = false; });

test("risk passed with MT5 connected: the reason does not say the bridge is not connected", async () => {
  mt5Connected = true;
  const body = await submit(valid);
  assert.equal(body.status, "READY_FOR_BROKER_WHEN_CONNECTED");
  assert.equal(body.mt5Connected, true);
  assert.doesNotMatch(String(body.reason), /not connected/i);
  assert.match(String(body.reason), /no real broker order was placed/i);
  assert.equal(body.brokerExecution, false);
  assert.equal(body.accepted, false);
});

test("risk passed with MT5 not connected: the reason says so", async () => {
  const body = await submit(valid);
  assert.equal(body.status, "PENDING_MT5_CONNECTION");
  assert.match(String(body.reason), /not connected/i);
});

test("risk failed: the reason names the failed check", async () => {
  mt5Connected = true;
  const body = await submit({ ...valid, stopLoss: null });
  assert.equal(body.status, "REJECTED_BY_RISK");
  assert.match(String(body.reason), /stopLoss is required/);
});
