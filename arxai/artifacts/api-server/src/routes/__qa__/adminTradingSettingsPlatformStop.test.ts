// GET /admin/trading/settings feeds the Admin Trading Control page's
// "Emergency stop" line. The settings row carries only the platform emergency
// stop; the pre-trade Risk Governor also refuses new orders while the
// safety-core kill switch is engaged. The response must carry both stops
// (platformStop(), as tradingHalt reads them) so the page can never say
// "Released" while a stop refuses orders.
//
// The real route runs. Stubbed: the settings row read and the safety-core
// read behind platformStop(). No DB, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/adminTradingSettingsPlatformStop.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

type Row = Record<string, unknown>;
const state: { row: Row | null; emergency: boolean; core: { readable: boolean; engaged: boolean; reason: string | null } } = {
  row: null, emergency: false, core: { readable: true, engaged: false, reason: null },
};

const realSwitches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...realSwitches,
    loadGlobalTradingSettingsRow: async () => state.row,
    platformStop: async () => realSwitches.platformStopFrom(
      { readable: true, emergencyStop: { engaged: state.emergency, reason: state.emergency ? "drill" : null, engagedAt: null } },
      { ...state.core, engagedAt: state.core.engaged ? new Date("2026-10-28T10:00:00Z") : null },
    ),
  },
});

const { default: express } = await import("express");
const { default: adminTradingRouter } = await import("../adminTrading.js");

async function getSettings(role = "ADMIN"): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 1, role };
    next();
  });
  app.use("/api", adminTradingRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/trading/settings`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const releasedRow: Row = {
  id: 1, platformMode: "LIVE", emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
  updatedAt: "2026-10-28T09:00:00.000Z", accountRoutingMode: "USER_OWNED_MT5",
};

test("safety-core kill switch engaged, emergency stop released: the response says a stop is engaged and names it", async () => {
  state.row = releasedRow; state.emergency = false;
  state.core = { readable: true, engaged: true, reason: "operator drill" };
  const r = await getSettings();
  assert.equal(r.status, 200);
  assert.equal((r.body["settings"] as Row)["emergencyKillSwitch"], false, "the stored row is passed through unchanged");
  assert.equal(r.body["platformStopEngaged"], true);
  assert.deepEqual(r.body["platformStopSources"], ["safety_core_kill_switch"]);
  assert.match(String(r.body["platformStopReason"]), /safety-core kill switch is engaged.*operator drill/);
  assert.equal(r.body["platformStopReadable"], true);
  assert.deepEqual(r.body["platformStopDetail"], { safety_core_kill_switch: "operator drill" });
  assert.equal((r.body["platformStopEngagedAt"] as Row)["safety_core_kill_switch"], "2026-10-28T10:00:00.000Z");
});

test("both stops released: platformStopEngaged false with no sources", async () => {
  state.row = releasedRow; state.emergency = false;
  state.core = { readable: true, engaged: false, reason: null };
  const r = await getSettings();
  assert.equal(r.body["platformStopEngaged"], false);
  assert.deepEqual(r.body["platformStopSources"], []);
  assert.equal(r.body["platformStopReason"], null);
});

test("safety core unreadable: engaged and not readable (never released)", async () => {
  state.row = null; state.emergency = false;
  state.core = { readable: false, engaged: true, reason: "state unreadable" };
  const r = await getSettings();
  assert.equal(r.body["settings"], null);
  assert.equal(r.body["platformStopEngaged"], true);
  assert.equal(r.body["platformStopReadable"], false);
  assert.deepEqual(r.body["platformStopDetail"], { safety_core_kill_switch: "state unreadable" });
});

test("non-operator sessions are still refused", async () => {
  const r = await getSettings("USER");
  assert.equal(r.status, 403);
  assert.equal(r.body["platformStopEngaged"], undefined);
});
