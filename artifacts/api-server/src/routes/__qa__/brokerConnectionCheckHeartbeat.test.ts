// GET /broker/connection-check carries the EA's heartbeat time and its band
// under the shared heartbeat policy, separate from lastCheckedAt (the request
// time). The MT5 Setup page labelled lastCheckedAt "Last heartbeat" and showed
// "Connected" for a heartbeat 50 s old, which /mt5/status calls stale.
//
// The broker provider and token lookup are module-mocked; the real route and
// the real shared heartbeat policy run. No database, broker or network.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

let lastHeartbeatAt: string | null = null;
let connected = false;

mock.module("../../lib/broker/registry.js", {
  namedExports: {
    getBrokerProvider: () => ({
      kind: "mt5",
      status: async () => {
        const staleSeconds = lastHeartbeatAt
          ? Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000)
          : null;
        return {
          kind: "mt5", connected,
          health: { connected, lastHeartbeatAt, staleSeconds, reason: "fixture" },
          environment: "DEMO", liveTradingAllowed: false, canPlaceLiveTrade: false,
          missingSecrets: [], notes: [],
        };
      },
      account: async () => null,
      symbols: async () => [],
      positions: async () => [],
      orders: async () => [],
    }),
  },
});
mock.module("../../lib/broker/secrets.js", {
  namedExports: {
    selectBrokerKind: () => "mt5",
    describeRequiredSecrets: () => [],
    missingRequiredSecrets: () => [],
    anyActiveUserBridgeTokenExists: async () => true,
  },
});

const { default: router } = await import("../broker.js");

async function connectionCheck(): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const req = {
      method: "GET", url: "/broker/connection-check", originalUrl: "/broker/connection-check",
      headers: {}, query: {}, authUser: { id: 7, role: "USER" },
    } as unknown as Request;
    const res = {
      statusCode: 200,
      status(code: number) { (this as { statusCode: number }).statusCode = code; return this; },
      json(body: Record<string, unknown>) { resolve(body); return this; },
      setHeader() { return this; },
    } as unknown as Response;
    (router as unknown as (rq: Request, rs: Response, next: (e?: unknown) => void) => void)(
      req, res, (e?: unknown) => reject(e ?? new Error("route not matched")),
    );
  });
}

test("a 50 s old heartbeat: lastHeartbeatAt is the EA's time, not the request time, and the band is degraded", async () => {
  lastHeartbeatAt = new Date(Date.now() - 50_000).toISOString();
  connected = true; // provider online flag (fresh OR degraded)
  const body = await connectionCheck();
  assert.equal(body.lastHeartbeatAt, lastHeartbeatAt);
  assert.notEqual(body.lastHeartbeatAt, body.lastCheckedAt);
  assert.equal(body.heartbeatFreshness, "degraded");
  assert.ok(typeof body.heartbeatAgeSeconds === "number" && body.heartbeatAgeSeconds >= 50);
});

test("a 5 s old heartbeat is fresh", async () => {
  lastHeartbeatAt = new Date(Date.now() - 5_000).toISOString();
  connected = true;
  const body = await connectionCheck();
  assert.equal(body.heartbeatFreshness, "fresh");
});

test("no heartbeat ever: lastHeartbeatAt is null and the band is unknown", async () => {
  lastHeartbeatAt = null;
  connected = false;
  const body = await connectionCheck();
  assert.equal(body.lastHeartbeatAt, null);
  assert.equal(body.heartbeatAgeSeconds, null);
  assert.equal(body.heartbeatFreshness, "unknown");
});
