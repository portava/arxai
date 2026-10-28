// GET /system/status (the Control Tower) reported only the safety-core kill
// switch. With the platform emergency stop or the trader's own kill switch
// engaged, the page said "Safety Core Online" while the Risk Command Center
// listed the halt. The status now carries every stop that halts the viewer's
// broker-venue orders, read by the Risk Governor's own reader, and says
// "could not be checked" (null) when that read fails.
//
// The safety core and the halt reader are stubbed; the real route runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/systemStatusHalts.test.ts

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const coreStatus = {
  operationalMode: "OBSERVE_ONLY", globalState: "NORMAL", effectiveProfile: {},
  killSwitchEngaged: false, killSwitchEngagedAt: null, killSwitchReason: null,
  mt5LinkHealth: "DOWN", lastMt5HeartbeatAt: null, secondsSinceMt5Heartbeat: null,
  lastModeChangeAt: null, lastModeChangedBy: null, reasons: [], blockers: [],
  allowedModes: ["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"],
};
mock.module("../../lib/safetyCore.js", {
  namedExports: {
    getStatus: async () => coreStatus,
    driveGlobalState: async () => undefined,
    setOperationalMode: async () => ({}),
    engageKillSwitch: async () => undefined,
    listVaultEvents: async () => [],
    listStateTransitions: async () => [],
  },
});
mock.module("../../lib/safety/platformStopWriter.js", {
  namedExports: { releasePlatformStop: async () => ({ ok: false, code: "NOT_AUTHORIZED", message: "stub" }) },
});

const REASONS: Record<string, string> = {
  platform_emergency_stop: "The platform emergency stop is engaged by an operator.",
  safety_core_kill_switch: "The safety-core kill switch is engaged.",
  trader_kill_switch: "Your kill switch is engaged. Release it to trade again.",
};
type Halt = { engaged: boolean; sources: string[]; reason: string | null };
const haltOf = (sources: string[], detail?: string): Halt =>
  sources.length
    ? { engaged: true, sources, reason: detail ? `${REASONS[sources[0]!]} (${detail})` : REASONS[sources[0]!]! }
    : { engaged: false, sources: [], reason: null };
let traderHalt: () => Promise<Halt> = async () => haltOf([]);
let platformHalt: () => Promise<Halt> = async () => haltOf([]);
const traderCalls: Array<{ userId: number; venue: string }> = [];
mock.module("../../lib/safety/tradingHalt.js", {
  namedExports: {
    loadTradingHalt: async (args: { userId: number; venue: string }) => { traderCalls.push(args); return traderHalt(); },
    loadPlatformHalt: async () => platformHalt(),
    haltFrom: (sources: string[]) => haltOf(sources),
  },
});

const { default: systemRouter } = await import("../system.js");

let server: Server;
let base = "";
let viewerId: number | null = 7;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (viewerId != null) (req as unknown as { authUser: unknown }).authUser = { id: viewerId, role: "USER" };
    next();
  });
  app.use("/api", systemRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const status = async () => {
  const r = await fetch(`${base}/system/status`);
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>;
};

test("the platform emergency stop is reported while the safety-core switch is released", async () => {
  viewerId = 7;
  traderHalt = async () => haltOf(["platform_emergency_stop"], "news spike");
  const s = await status();
  assert.equal(s.killSwitchEngaged, false);
  assert.deepEqual(s.activeHalts, ["platform_emergency_stop"]);
  assert.deepEqual(s.activeHaltReasons, ["The platform emergency stop is engaged by an operator. (news spike)"]);
  assert.equal(typeof s.activeHaltsCheckedAt, "string");
  // Read for this viewer on a broker venue, with the Risk Governor's reader.
  assert.deepEqual(traderCalls.at(-1), { userId: 7, venue: "LIVE" });
});

test("the viewer's own kill switch is reported, one reason per stop", async () => {
  viewerId = 7;
  traderHalt = async () => haltOf(["platform_emergency_stop", "trader_kill_switch"]);
  const s = await status();
  assert.deepEqual(s.activeHalts, ["platform_emergency_stop", "trader_kill_switch"]);
  assert.equal((s.activeHaltReasons as string[]).length, 2);
  assert.match((s.activeHaltReasons as string[])[1]!, /Your kill switch is engaged/);
});

test("no stop engaged is an empty list, not missing", async () => {
  viewerId = 7;
  traderHalt = async () => haltOf([]);
  const s = await status();
  assert.deepEqual(s.activeHalts, []);
  assert.deepEqual(s.activeHaltReasons, []);
});

test("without a signed-in viewer the install-wide stops are still read", async () => {
  viewerId = null;
  platformHalt = async () => haltOf(["platform_emergency_stop"]);
  const s = await status();
  assert.deepEqual(s.activeHalts, ["platform_emergency_stop"]);
});

test("a halt read that throws is 'could not be checked' (null), never an empty list", async () => {
  viewerId = 7;
  traderHalt = async () => { throw new Error("db down"); };
  const s = await status();
  assert.equal(s.activeHalts, null);
  assert.deepEqual(s.activeHaltReasons, []);
  // The safety-core status itself still loads.
  assert.equal(s.killSwitchEngaged, false);
});
