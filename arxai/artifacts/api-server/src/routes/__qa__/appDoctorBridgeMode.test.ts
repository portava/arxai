// GET /api/mt5/diagnostic-summary — bridge mode must follow the heartbeat
// authority, not the legacy MT5_BRIDGE_TOKEN env var.
//
// The env token is rejected on every EA endpoint (per-user bridge tokens are
// the only EA auth), so in production it is normally absent. The defect this
// locks: with no env token the summary always said bridgeMode "deferred" and
// paperOnly true, so the Status Command Center showed "MT5 Deferred" /
// "Simulator Mode" / "synthetic candles" while a user's EA was heartbeating.
//
// The real appDoctor router runs; the heartbeat status it reads over loopback
// HTTP is a stub mounted on the same test server. No database, no network.
//
// Run: node --import tsx --test --test-force-exit src/routes/__qa__/appDoctorBridgeMode.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import appDoctorRouter from "../appDoctor.js";

type Hb = { status: number; body?: Record<string, unknown> };

async function summary(hb: Hb): Promise<Record<string, unknown>> {
  const app = express();
  app.get("/api/mt5/heartbeat/status", (_req, res) => { res.status(hb.status).json(hb.body ?? {}); });
  app.use("/api", appDoctorRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/mt5/diagnostic-summary`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const saved = process.env["MT5_BRIDGE_TOKEN"];
delete process.env["MT5_BRIDGE_TOKEN"];
process.on("exit", () => { if (saved !== undefined) process.env["MT5_BRIDGE_TOKEN"] = saved; });

test("a heartbeating EA on a per-user token is connected, not deferred, with no env token", async () => {
  const s = await summary({ status: 200, body: {
    eaConnected: true, lastHeartbeatAt: new Date().toISOString(), heartbeatAgeSeconds: 3, bridgeTokenConfigured: true,
  } });
  assert.equal(s["bridgeMode"], "connected");
  assert.equal(s["paperOnly"], false);
  assert.equal(s["heartbeatPresent"], true);
  assert.equal(s["heartbeatAgeSeconds"], 3);
  assert.doesNotMatch(String(s["reason"]), /MT5_BRIDGE_TOKEN/);
  // Execution authority is unchanged by the bridge being connected.
  assert.equal(s["liveTradingEnabled"], false);
  assert.equal(s["brokerExecutionEnabled"], false);
  assert.equal(s["brokerReadOnly"], true);
});

test("an active per-user token with no fresh heartbeat is disconnected", async () => {
  const s = await summary({ status: 200, body: { eaConnected: false, heartbeatAgeSeconds: 900, bridgeTokenConfigured: true } });
  assert.equal(s["bridgeMode"], "disconnected");
  assert.equal(s["paperOnly"], true);
});

test("no active token and no heartbeat is deferred, and the copy does not point at the rejected env token", async () => {
  const s = await summary({ status: 200, body: { eaConnected: false, heartbeatAgeSeconds: null, bridgeTokenConfigured: false } });
  assert.equal(s["bridgeMode"], "deferred");
  assert.equal(s["paperOnly"], true);
  assert.doesNotMatch(String(s["reason"]), /MT5_BRIDGE_TOKEN/);
  assert.doesNotMatch(String(s["safestNextStep"]), /MT5_BRIDGE_TOKEN/);
});

test("an unreadable heartbeat status is unknown, never connected", async () => {
  const s = await summary({ status: 500 });
  assert.equal(s["bridgeMode"], "unknown");
  assert.equal(s["paperOnly"], true);
  assert.equal(s["heartbeatPresent"], false);
});
