// /api/system-health/status and /api/system-health/config returned the system
// config registry (lib/systemHealth/config.ts getConfig) with
// appMode "PAPER_ONLY" and liveTradingEnabled false — fields hard-locked in
// code, never read from anywhere — as their only live-trading words, even
// with the platform's live-execution switch on and LIVE_SHARED traders armed.
// getConfig() output is also persisted verbatim in admin action snapshots, so
// it stays unchanged; the two responses now say what those fields are
// (liveTradingStatusScope) and carry the platform switch as read for the
// response (livePosture, UNKNOWN when unreadable). Describes only; no gate
// reads it.
//
// Runs the REAL systemHealth router with the config registry, health-check
// list and platform switch reader replaced by fixtures: no database, no
// broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/systemHealthConfigLivePosture.test.ts

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const state = { readable: true, enabled: true };
const realSwitches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...realSwitches,
    readPlatformSwitches: async () => ({
      readable: state.readable,
      liveBrokerExecution: {
        envEnabled: state.enabled, operatorArmed: state.enabled, enabled: state.enabled && state.readable,
        armedAt: null, armedBy: null, armedBridgeId: null,
      },
    }),
  },
});

const config = {
  id: 1, appMode: "PAPER_ONLY", liveTradingEnabled: false, brokerMode: "READ_ONLY",
  marketDataMode: "read_only", paperAutopilotEnabled: false, notificationCriticalAlwaysOn: true,
  replayOnlyMode: false, dataImportEnabled: false, secretRedactionEnabled: true,
  currentSafetyLock: null, lastHealthCheckAt: null,
  createdAt: new Date("2026-10-28T10:00:00.000Z"), updatedAt: new Date("2026-10-28T10:00:00.000Z"),
};
const realConfig = await import("../../lib/systemHealth/config.js");
mock.module("../../lib/systemHealth/config.js", {
  namedExports: { ...realConfig, getConfig: async () => config },
});
const realHealth = await import("../../lib/systemHealth/health.js");
mock.module("../../lib/systemHealth/health.js", {
  namedExports: { ...realHealth, listHealthChecks: async () => [] },
});

const { default: router } = await import("../systemHealth.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200, path);
  return (await r.json()) as Record<string, unknown>;
}

const PATHS = ["/api/system-health/status", "/api/system-health/config"];

test("live execution switched on: status and config say so beside the hard-locked config fields", async () => {
  state.readable = true; state.enabled = true;
  for (const path of PATHS) {
    const r = await get(path);
    const lp = r["livePosture"] as { state: string; plainEnglish: string; source: string } | undefined;
    assert.ok(lp, `${path}: livePosture present`);
    assert.equal(lp.state, "ON", path);
    assert.match(lp.plainEnglish, /switched on for the platform/, path);
    const cfg = r["config"] as { liveTradingEnabled: boolean; appMode: string };
    assert.equal(cfg.liveTradingEnabled, false, `${path}: the config field is unchanged`);
    assert.equal(cfg.appMode, "PAPER_ONLY", `${path}: the config field is unchanged`);
    const scope = String(r["liveTradingStatusScope"] ?? "");
    assert.match(scope, /not whether live trading is on/, path);
    assert.match(scope, /liveTradingEnabled/, path);
  }
});

test("live execution switched off: livePosture is OFF with what was read", async () => {
  state.readable = true; state.enabled = false;
  const r = await get("/api/system-health/config");
  const lp = r["livePosture"] as { state: string; plainEnglish: string };
  assert.equal(lp.state, "OFF");
  assert.match(lp.plainEnglish, /switched off for the platform \(server setting off, operator arm off/);
});

test("switch unreadable: livePosture is UNKNOWN, not OFF", async () => {
  state.readable = false; state.enabled = false;
  for (const path of PATHS) {
    const r = await get(path);
    const lp = r["livePosture"] as { state: string; plainEnglish: string };
    assert.equal(lp.state, "UNKNOWN", path);
    assert.match(lp.plainEnglish, /could not be read/, path);
  }
});
