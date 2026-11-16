// Admin Workflow Health headline — `ok` must cover what the card calls
// "Healthy", not only the database ping.
//
// The defect this locks: with the DB answering, `ok` was true even when every
// MT5/EA bridge heartbeat was in the "down" band or the bridge aggregate query
// threw (and its failure left the counts at zero, indistinguishable from "no
// bridges"). Only the DB handle, the bridge connection list and the admin
// handshake are stubbed; the real router runs. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/adminRuntimeHealthHeadline.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
let dbFails = false;
mock.module("@workspace/db", {
  namedExports: {
    ...database,
    db: { execute: async () => { if (dbFails) throw new Error("db down"); return []; } },
  },
});

let connRows: Array<{ lastHeartbeat: Date | null }> = [];
let connThrows = false;
const connections = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: {
    ...connections,
    listConnections: async () => { if (connThrows) throw new Error("aggregate failed"); return connRows; },
  },
});
const handshake = await import("../../lib/security/handshake.js");
mock.module("../../lib/security/handshake.js", {
  namedExports: { ...handshake, enforceSensitiveAction: async () => ({ ok: true }) },
});

const express = (await import("express")).default;
const router = (await import("../adminRuntimeHealth.js")).default;

async function get(): Promise<Record<string, any>> {
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 1, role: "ADMIN" }; next(); });
  app.use("/api", router);
  const server: Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/runtime-health`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, any>;
  } finally {
    server.close();
  }
}

beforeEach(() => { dbFails = false; connRows = []; connThrows = false; });

test("all bridges down: ok is not true even though the DB answers", async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  connRows = [{ lastHeartbeat: old }, { lastHeartbeat: old }, { lastHeartbeat: null }];
  const body = await get();
  assert.equal(body.database.ok, true);
  assert.equal(body.bridge.down, 3);
  assert.notEqual(body.ok, true);
});

test("bridge aggregate throws: ok is not true and the counts are marked unreadable", async () => {
  connThrows = true;
  const body = await get();
  assert.equal(body.database.ok, true);
  assert.equal(body.bridge.readable, false);
  assert.notEqual(body.ok, true);
});

test("DB up and a fresh bridge heartbeat: ok stays true", async () => {
  connRows = [{ lastHeartbeat: new Date() }];
  const body = await get();
  assert.equal(body.bridge.readable, true);
  assert.equal(body.bridge.healthy, 1);
  assert.equal(body.ok, true);
});

test("DB up and no bridges registered: ok stays true (nothing to be down)", async () => {
  const body = await get();
  assert.equal(body.bridge.total, 0);
  assert.equal(body.ok, true);
});

test("DB down: ok is false", async () => {
  dbFails = true;
  connRows = [{ lastHeartbeat: new Date() }];
  const body = await get();
  assert.equal(body.ok, false);
});
