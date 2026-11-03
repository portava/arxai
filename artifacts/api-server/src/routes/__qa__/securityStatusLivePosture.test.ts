// /api/security/status (the Security Center page) returned appMode
// "PAPER_ONLY" and liveTradingStatus "DISABLED" as its only live-trading
// words, and the page showed "Live trading: DISABLED" in red, even with the
// platform's live-execution switch on. The labels stay; the status responses
// now say what they cover (liveTradingStatusScope) and carry the platform
// switch as read for the response (livePosture, UNKNOWN when unreadable).
//
// Runs the REAL security router with the security status builder, seeding,
// settings and platform switch reader replaced by fixtures: no database, no
// broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/securityStatusLivePosture.test.ts

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const state = { readable: true, enabled: true };
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: state.readable,
      liveBrokerExecution: {
        envEnabled: state.enabled, operatorArmed: state.enabled, enabled: state.enabled && state.readable,
        armedAt: null, armedBy: null, armedBridgeId: null,
      },
    }),
  },
});
const report = {
  security_status_id: "secstatus_1", generated_at: "2026-10-28T11:40:00.000Z",
  appMode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
  authStatus: {}, permissionStatus: {}, dataProtectionStatus: {},
  securityFlags: [], warnings: [], criticalFindings: [], recommendedActions: [],
};
const realService = await import("../../lib/security/service.js");
mock.module("../../lib/security/service.js", {
  namedExports: {
    ...realService,
    buildSecurityStatus: async () => report,
    createDataProtectionExport: async () => ({}),
    listDataProtectionExports: async () => [],
  },
});
const realSeed = await import("../../lib/security/seed.js");
mock.module("../../lib/security/seed.js", {
  namedExports: { ...realSeed, seedSecurity: async () => ({ rolesCreated: 0, permissionsCreated: 0, mappingsCreated: 0 }) },
});
const realSettings = await import("../../lib/security/settings.js");
mock.module("../../lib/security/settings.js", {
  namedExports: { ...realSettings, getSettings: async () => ({}), patchSettings: async () => ({ settings: {}, rejected: [] }) },
});

const { default: router } = await import("../security.js");

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

async function call(method: "GET" | "POST", path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  assert.equal(r.status, 200, `${method} ${path}`);
  return (await r.json()) as Record<string, unknown>;
}

test("live execution switched on: the security status says so beside its fixed labels", async () => {
  state.readable = true; state.enabled = true;
  for (const [method, path] of [["GET", "/api/security/status"], ["POST", "/api/security/check"]] as const) {
    const r = await call(method, path);
    const lp = r["livePosture"] as { state: string; plainEnglish: string } | undefined;
    assert.ok(lp, `${path}: livePosture present`);
    assert.equal(lp.state, "ON");
    assert.match(lp.plainEnglish, /switched on for the platform/);
    assert.equal((r["status"] as { liveTradingStatus: string }).liveTradingStatus, "DISABLED", "the label is unchanged");
    assert.match(String(r["liveTradingStatusScope"]), /not whether live trading is on/);
  }
});

test("switch unreadable: livePosture is UNKNOWN, not OFF", async () => {
  state.readable = false; state.enabled = false;
  const r = await call("GET", "/api/security/status");
  const lp = r["livePosture"] as { state: string; plainEnglish: string };
  assert.equal(lp.state, "UNKNOWN");
  assert.match(lp.plainEnglish, /could not be read/);
});
