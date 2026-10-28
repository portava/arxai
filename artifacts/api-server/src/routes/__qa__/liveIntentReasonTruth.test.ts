// Truth regression: POST /live-intent/submit's reason agrees with its own
// mt5Connected and status fields.
//
// Before: when the tester caps passed, the reason was always "MT5 bridge is
// not connected yet…", even when the server had just measured the bridge as
// connected and returned status READY_FOR_BROKER_WHEN_CONNECTED with
// mt5Connected=true on the same card.
//
// Offline: the db, the broker kind and the provider status are module-mocked.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/routes/__qa__/liveIntentReasonTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let kind = "mt5";
let connected = false;
mock.module("../../lib/broker/secrets.js", { namedExports: { selectBrokerKind: () => kind } });
mock.module("../../lib/broker/registry.js", {
  namedExports: { getBrokerProvider: () => ({ status: async () => ({ connected }) }) },
});

const router = (await import("../liveIntent.js")).default;

const TICKET = { source: "MANUAL", symbol: "EURUSD", direction: "BUY", lotSize: 0.01, stopLoss: 1.05 };

async function submit(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 3 }, async (base) => {
    const r = await fetch(`${base}/live-intent/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(TICKET),
    });
    assert.equal(r.status, 200);
    body = (await r.json()) as Record<string, unknown>;
  });
  return body;
}

test("a connected bridge is not described as 'not connected yet'", async () => {
  kind = "mt5"; connected = true;
  const body = await submit();
  assert.equal(body["mt5Connected"], true);
  assert.equal(body["status"], "READY_FOR_BROKER_WHEN_CONNECTED");
  assert.doesNotMatch(String(body["reason"]), /not connected/i);
  assert.match(String(body["reason"]), /reported connected/);
  assert.match(String(body["reason"]), /no real broker order was placed/);
});

test("a disconnected bridge still says so", async () => {
  kind = "mt5"; connected = false;
  const body = await submit();
  assert.equal(body["mt5Connected"], false);
  assert.equal(body["status"], "PENDING_MT5_CONNECTION");
  assert.match(String(body["reason"]), /MT5 bridge is not connected/);
});

test("a failed tester cap names the cap, whatever the bridge", async () => {
  kind = "mt5"; connected = true;
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 3 }, async (base) => {
    const r = await fetch(`${base}/live-intent/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...TICKET, lotSize: 1 }),
    });
    body = (await r.json()) as Record<string, unknown>;
  });
  assert.equal(body["status"], "REJECTED_BY_RISK");
  assert.match(String(body["reason"]), /Risk check failed: lotSize 1 exceeds tester cap/);
});
