// /permission/status (and /permission/evaluate) carry a testerAccess overlay
// with mt5Connected. When the broker status read threw, the overlay reported
// mt5Connected:false with "MT5 bridge not connected yet" — an unchecked state
// shown as a checked "not connected". It must say the check failed (null).
// The broker provider is stubbed; no database, broker or network is touched.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state: { mode: "throws" | "connected" | "disconnected" } = { mode: "throws" };
mock.module("../../lib/broker/registry.js", {
  namedExports: {
    getBrokerProvider: () => ({
      status: async () => {
        if (state.mode === "throws") throw new Error("mt5_state read failed");
        return { connected: state.mode === "connected" };
      },
    }),
    resetBrokerProviderForTests: () => undefined,
  },
});
process.env.BROKER_PROVIDER = "mt5";
const { buildTesterAccessOverlay } = await import("../permission.js");

test("a broker status read that throws is reported as unknown, not as not connected", async () => {
  state.mode = "throws";
  const o = await buildTesterAccessOverlay();
  assert.equal(o.mt5Connected, null);
  assert.match(o.reason, /could not check/i);
  assert.doesNotMatch(o.reason, /not connected yet/);
  assert.equal(o.canExecuteRealBrokerOrder, false);
  assert.equal(o.brokerExecutionAvailable, false);
});

test("a real status read still reports connected and not connected", async () => {
  state.mode = "disconnected";
  const off = await buildTesterAccessOverlay();
  assert.equal(off.mt5Connected, false);
  assert.match(off.reason, /not connected/);
  state.mode = "connected";
  const on = await buildTesterAccessOverlay();
  assert.equal(on.mt5Connected, true);
  assert.equal(on.canExecuteRealBrokerOrder, false);
});
