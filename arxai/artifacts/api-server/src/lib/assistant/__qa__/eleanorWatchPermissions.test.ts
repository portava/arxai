// Arm-time and fire-time permission rule for Eleanor watches (sweep 2026-11-04):
// the watch permission AND the instant-trade pipeline's own open/close
// permission are both required, so a watch is never armed only to be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eleanorWatchPermissionBlock } from "../eleanorWatchPermissions.js";

const all = {
  eleanorExecutionAuthority: "AI_ASSISTED", allowEleanorWatchEnter: true, allowEleanorWatchClose: true, allowEleanorMonitor: true,
  allowEleanorOpenCommands: true, allowEleanorCloseCommands: true,
};

test("everything on → allowed for every kind", () => {
  for (const k of ["WATCH_AND_ENTER", "WATCH_AND_CLOSE", "MONITOR_TRADE"]) assert.equal(eleanorWatchPermissionBlock(k, all), null, k);
});

test("default-deny: no settings row blocks every kind", () => {
  assert.equal(eleanorWatchPermissionBlock("WATCH_AND_ENTER", undefined), "ELEANOR_WATCH_ENTER_NOT_ENABLED");
  assert.equal(eleanorWatchPermissionBlock("MONITOR_TRADE", null), "ELEANOR_MONITOR_NOT_ENABLED");
});

test("authority other than AI_ASSISTED blocks", () => {
  for (const a of ["OFF", "ADVISE_ONLY", "AI_AUTO", null]) {
    assert.equal(eleanorWatchPermissionBlock("MONITOR_TRADE", { ...all, eleanorExecutionAuthority: a }), "ELEANOR_EXECUTION_NOT_AUTHORIZED", String(a));
  }
});

test("the pipeline's open/close permission is required on top of the watch permission", () => {
  assert.equal(eleanorWatchPermissionBlock("WATCH_AND_ENTER", { ...all, allowEleanorOpenCommands: false }), "ELEANOR_OPEN_COMMANDS_NOT_ENABLED");
  assert.equal(eleanorWatchPermissionBlock("WATCH_AND_CLOSE", { ...all, allowEleanorCloseCommands: false }), "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED");
  assert.equal(eleanorWatchPermissionBlock("MONITOR_TRADE", { ...all, allowEleanorCloseCommands: false }), "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED");
  // An entry watch does not need close permission, nor a close watch open permission.
  assert.equal(eleanorWatchPermissionBlock("WATCH_AND_ENTER", { ...all, allowEleanorCloseCommands: false }), null);
  assert.equal(eleanorWatchPermissionBlock("WATCH_AND_CLOSE", { ...all, allowEleanorOpenCommands: false }), null);
});
