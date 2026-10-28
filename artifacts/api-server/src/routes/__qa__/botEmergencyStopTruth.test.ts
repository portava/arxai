// Truth regression: what POST /bot/emergency-stop says it did.
//
// Before: the message read "your trades cancelled" even when no row was
// cancelled (it only touches OPEN rows in the legacy `trades` table, which
// takes no new rows; paper-book and broker positions stay open), and nothing
// told an operator before or after the press that their stop halts every
// trader on the platform.
//
// Offline: the db, the two kill-switch writers and the legacy-book cancel are
// module-mocked; the real router runs on loopback.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/routes/__qa__/botEmergencyStopTruth.test.ts

import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const BOT_ROW = {
  id: 7, userId: 1, mode: "DEMO", symbol: "EURUSD", strategy: "Trend", riskMode: "Balanced",
  isRunning: true, isPaused: false, lastScanAt: null as Date | null,
};
const chain = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [BOT_ROW] }) }) }),
  update: () => ({ set: () => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => [BOT_ROW] }) }) }),
  insert: () => ({ values: () => ({ returning: async () => [BOT_ROW] }) }),
};
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: chain } });

const calls = { platform: 0, trader: 0 };
mock.module("../../lib/safetyCore.js", { namedExports: { engageKillSwitch: async () => { calls.platform++; } } });
mock.module("../../lib/live/liveArming.js", { namedExports: { engageKillSwitchForUser: async () => { calls.trader++; } } });
let openLegacyRows: unknown[] = [];
mock.module("../../lib/trades/paperBook.js", { namedExports: { cancelOpenLegacyTrades: async () => openLegacyRows } });

const { default: router } = await import("../bot.js");

let role = "USER";
let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 1, role, email: "t@example.test" };
    next();
  });
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = { error: () => undefined }; next(); });
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { calls.platform = 0; calls.trader = 0; openLegacyRows = []; role = "USER"; });

async function stop(): Promise<{ message: string; closedTrades: number; scope?: string }> {
  const r = await fetch(`${base}/api/bot/emergency-stop`, { method: "POST" });
  assert.equal(r.status, 200);
  return (await r.json()) as { message: string; closedTrades: number; scope?: string };
}

test("a trader stop with no open legacy rows does not claim trades were cancelled", async () => {
  const body = await stop();
  assert.equal(calls.trader, 1);
  assert.equal(calls.platform, 0);
  assert.equal(body.closedTrades, 0);
  assert.equal(body.scope, "YOUR_ACCOUNT");
  assert.doesNotMatch(body.message, /trades cancelled/i);
  assert.match(body.message, /No open rows in the legacy simulated trades table needed cancelling/);
  assert.match(body.message, /paper-book and broker positions were not closed/);
  assert.match(body.message, /Your kill switch is engaged/);
  assert.match(body.message, /Resume on Risk Command Center/);
});

test("cancelled legacy rows are counted as what they are", async () => {
  openLegacyRows = [{ id: 1 }, { id: 2 }];
  const body = await stop();
  assert.equal(body.closedTrades, 2);
  assert.match(body.message, /Cancelled 2 open rows in the legacy simulated trades table/);
});

test("an operator stop says it halts every trader on the platform", async () => {
  role = "OWNER";
  const body = await stop();
  assert.equal(calls.platform, 1);
  assert.equal(calls.trader, 0);
  assert.equal(body.scope, "PLATFORM");
  assert.match(body.message, /halts new trades for every trader/);
  assert.match(body.message, /An operator releases it on the Emergency page/);
});

test("GET /bot/status says who the emergency stop would halt, before the press", async () => {
  const r1 = await fetch(`${base}/api/bot/status`);
  assert.equal(((await r1.json()) as { emergencyStopScope?: string }).emergencyStopScope, "YOUR_ACCOUNT");
  role = "ADMIN";
  const r2 = await fetch(`${base}/api/bot/status`);
  assert.equal(((await r2.json()) as { emergencyStopScope?: string }).emergencyStopScope, "PLATFORM");
});
