// Arm-time and fire-time permission rule for Ruby watches (sweep 2026-11-04):
// the watch permission AND the instant-trade pipeline's own open/close
// permission are both required, so a watch is never armed only to be refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rubyWatchPermissionBlock } from "../rubyWatchPermissions.js";

const all = {
  rubyExecutionAuthority: "AI_ASSISTED", allowRubyWatchEnter: true, allowRubyWatchClose: true, allowRubyMonitor: true,
  allowRubyOpenCommands: true, allowRubyCloseCommands: true,
};

test("everything on → allowed for every kind", () => {
  for (const k of ["WATCH_AND_ENTER", "WATCH_AND_CLOSE", "MONITOR_TRADE"]) assert.equal(rubyWatchPermissionBlock(k, all), null, k);
});

test("default-deny: no settings row blocks every kind", () => {
  assert.equal(rubyWatchPermissionBlock("WATCH_AND_ENTER", undefined), "RUBY_WATCH_ENTER_NOT_ENABLED");
  assert.equal(rubyWatchPermissionBlock("MONITOR_TRADE", null), "RUBY_MONITOR_NOT_ENABLED");
});

test("authority other than AI_ASSISTED blocks", () => {
  for (const a of ["OFF", "ADVISE_ONLY", "AI_AUTO", null]) {
    assert.equal(rubyWatchPermissionBlock("MONITOR_TRADE", { ...all, rubyExecutionAuthority: a }), "RUBY_EXECUTION_NOT_AUTHORIZED", String(a));
  }
});

test("the pipeline's open/close permission is required on top of the watch permission", () => {
  assert.equal(rubyWatchPermissionBlock("WATCH_AND_ENTER", { ...all, allowRubyOpenCommands: false }), "RUBY_OPEN_COMMANDS_NOT_ENABLED");
  assert.equal(rubyWatchPermissionBlock("WATCH_AND_CLOSE", { ...all, allowRubyCloseCommands: false }), "RUBY_CLOSE_COMMANDS_NOT_ENABLED");
  assert.equal(rubyWatchPermissionBlock("MONITOR_TRADE", { ...all, allowRubyCloseCommands: false }), "RUBY_CLOSE_COMMANDS_NOT_ENABLED");
  // An entry watch does not need close permission, nor a close watch open permission.
  assert.equal(rubyWatchPermissionBlock("WATCH_AND_ENTER", { ...all, allowRubyCloseCommands: false }), null);
  assert.equal(rubyWatchPermissionBlock("WATCH_AND_CLOSE", { ...all, allowRubyOpenCommands: false }), null);
});
