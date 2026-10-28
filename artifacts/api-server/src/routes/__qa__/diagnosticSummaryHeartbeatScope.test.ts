// GET /mt5/diagnostic-summary reports the CALLER's EA heartbeat, not the
// platform bridge's.
//
// The Status Command Center reads heartbeatPresent / heartbeatAgeSeconds from
// this route. It used to self-fetch the unauthenticated /mt5/heartbeat/status,
// which reads the platform-wide mt5_state singleton, so user B (no EA) saw
// "Heartbeat: present" because user A's EA was heartbeating — and a user whose
// own EA was fine saw "Missing Heartbeat" when the singleton went stale.
//
// Offline: the connection reader is module-mocked and global fetch is stubbed
// to answer the platform heartbeat probe; the router is mounted on loopback.

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const conns = new Map<number, { lastHeartbeat: Date | null }>();
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: {
    getUserActiveConnection: async (userId: number) => conns.get(userId) ?? null,
  },
});

const realFetch = globalThis.fetch;
const PLATFORM_HB = {
  eaConnected: true, lastHeartbeatAt: new Date().toISOString(), heartbeatAgeSeconds: 2,
  bridgeTokenConfigured: true,
};

const { default: router } = await import("../appDoctor.js");

let server: Server;
let base: string;
let caller: number | null = null;
before(async () => {
  process.env["MT5_BRIDGE_TOKEN"] = "fixture-configured";
  const app = express();
  app.use((req, _res, next) => {
    if (caller != null) (req as unknown as { authUser: { id: number } }).authUser = { id: caller };
    next();
  });
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The route's self-probe of /api/mt5/heartbeat/status answers with the
  // platform singleton (user A's EA heartbeating). Everything else is real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/mt5/heartbeat/status")) {
      return new Response(JSON.stringify(PLATFORM_HB), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

async function summary(): Promise<Record<string, unknown>> {
  const r = await realFetch(`${base}/api/mt5/diagnostic-summary`);
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>;
}

test("user B with no EA does not see user A's heartbeat as present", async () => {
  conns.set(1, { lastHeartbeat: new Date(Date.now() - 2_000) });
  caller = 2;
  const body = await summary();
  assert.equal(body["heartbeatPresent"], false, "B has no connection: heartbeat is not present for B");
  assert.equal(body["heartbeatAgeSeconds"], null);
  assert.notEqual(body["bridgeMode"], "connected");
  assert.equal(body["heartbeatScope"], "no_connection");
});

test("user A sees their own fresh heartbeat with its age", async () => {
  conns.set(1, { lastHeartbeat: new Date(Date.now() - 3_000) });
  caller = 1;
  const body = await summary();
  assert.equal(body["heartbeatPresent"], true);
  assert.equal(body["heartbeatScope"], "your_connection");
  assert.ok(typeof body["heartbeatAgeSeconds"] === "number" && (body["heartbeatAgeSeconds"] as number) <= 5);
});

test("a user whose own EA is stale is not shown as present even when the platform singleton is fresh", async () => {
  conns.set(3, { lastHeartbeat: new Date(Date.now() - 10 * 60_000) });
  caller = 3;
  const body = await summary();
  assert.equal(body["heartbeatPresent"], false);
  assert.ok((body["heartbeatAgeSeconds"] as number) >= 600);
});

// getUserActiveConnection only returns a connection with an active bridge
// token (activeTokenOnly), so a caller who has one HAS a token. A stopped EA
// is "disconnected" (verify the EA), never "deferred / no bridge token is
// active / create a bridge token" — that copy hid a real outage.
test("a user with an active token whose EA stopped heartbeating is disconnected, not deferred", async () => {
  conns.set(4, { lastHeartbeat: new Date(Date.now() - 30_000) });
  caller = 4;
  const body = await summary();
  assert.equal(body["heartbeatScope"], "your_connection");
  assert.equal(body["bridgeMode"], "disconnected");
  assert.doesNotMatch(String(body["reason"]), /no MT5 bridge token is active/i);
  assert.match(String(body["reason"]), /bridge token is active/i);
  assert.match(String(body["safestNextStep"]), /verify the EA is running/i);
  assert.doesNotMatch(String(body["safestNextStep"]), /Create a bridge token/i);
});

test("a user with no EA connection of their own is told that, about their own account", async () => {
  caller = 5;
  const body = await summary();
  assert.equal(body["heartbeatScope"], "no_connection");
  assert.equal(body["bridgeMode"], "deferred");
  assert.match(String(body["reason"]), /no MT5 EA connection of your own/i);
  assert.match(String(body["safestNextStep"]), /Create a bridge token/i);
});
