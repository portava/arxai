// The admin EA-health update preview reads the same gate inputs as the EA's
// real update check (GET /mt5/update-check). Before, the preview hardcoded the
// trader kill switch, maintenance mode and open-trade inputs to false, so it
// could say "update allowed" where the EA's real check blocked.
//
// Pure: the DB reads are injected; no DB rows are touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateEaUpdateGate } from "@workspace/domain/safety-contracts";
import {
  loadEaUpdateGateSafetyInputs,
  previewEaUpdateGateSafety,
  isHeartbeatStableForEaUpdate,
  type EaUpdateGateReaders,
} from "../eaUpdateGateInputs.js";
import { EA_HEARTBEAT_FRESH_MS } from "../../brokerHub/freshness.js";

const SRC = join(import.meta.dirname, "../../..");

function readers(state: Partial<Record<keyof EaUpdateGateReaders, boolean>>, calls: string[] = []): EaUpdateGateReaders {
  const r = (k: keyof EaUpdateGateReaders) => async (userId: number) => {
    calls.push(`${k}:${userId}`);
    return state[k] ?? false;
  };
  return {
    killSwitchEngaged: r("killSwitchEngaged"),
    hasOpenLiveTrade: r("hasOpenLiveTrade"),
    hasPendingCommand: r("hasPendingCommand"),
    maintenanceMode: r("maintenanceMode"),
  };
}

const NOW = new Date("2026-10-24T12:00:00Z");
const freshHb = new Date(NOW.getTime() - 5_000);

// A manifest that ALLOWs when every safety input is clear.
function gate(safety: Awaited<ReturnType<typeof loadEaUpdateGateSafetyInputs>>) {
  return evaluateEaUpdateGate({
    manifest: { version: "2.0.0", channel: "stable", releaseStatus: "approved", sha256Checksum: "abc", isUpdaterCapable: true },
    currentVersion: "1.0.0",
    allowedChannels: ["stable"],
    eaSupportsSelfUpdate: true,
    ...safety,
  });
}

test("clear inputs: the preview allows, as the real gate would", async () => {
  const s = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({}));
  assert.deepEqual(s, { hasOpenLiveTrade: false, hasPendingCommand: false, heartbeatStable: true, killSwitchEngaged: false, maintenanceMode: false });
  assert.equal(gate(s).decision, "ALLOW");
});

test("trader kill switch engaged: the preview now blocks (was hardcoded false)", async () => {
  const s = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ killSwitchEngaged: true }));
  assert.equal(s.killSwitchEngaged, true);
  assert.deepEqual([gate(s).decision, gate(s).reason], ["BLOCK", "KILL_SWITCH_ENGAGED"]);
});

test("remote-config maintenance mode: the preview now blocks (was hardcoded false)", async () => {
  const s = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ maintenanceMode: true }));
  assert.deepEqual([gate(s).decision, gate(s).reason], ["BLOCK", "MAINTENANCE_MODE"]);
});

test("open LIVE trade and in-flight command come from the same reads as the real gate", async () => {
  const open = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ hasOpenLiveTrade: true }));
  assert.equal(gate(open).reason, "OPEN_LIVE_TRADE");
  const pending = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ hasPendingCommand: true }));
  assert.equal(gate(pending).reason, "COMMAND_PENDING");
});

test("reads are scoped to the trader and run in the update-check order", async () => {
  const calls: string[] = [];
  await loadEaUpdateGateSafetyInputs(42, freshHb, { nowMs: NOW.getTime(), readers: readers({}, calls) });
  assert.deepEqual(calls, ["killSwitchEngaged:42", "hasOpenLiveTrade:42", "hasPendingCommand:42", "maintenanceMode:42"]);
});

test("heartbeat stability is the 15 s gate window in ms (not the watchdog's floored seconds)", () => {
  const now = NOW.getTime();
  assert.equal(EA_HEARTBEAT_FRESH_MS, 15_000);
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now - 15_000), now), true);
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now - 15_001), now), false);
  assert.equal(isHeartbeatStableForEaUpdate(null, now), false);
});

test("a userless connection reads no trader state", async () => {
  const calls: string[] = [];
  const s = await previewEaUpdateGateSafety(null, freshHb, NOW, readers({ killSwitchEngaged: true }, calls));
  assert.deepEqual(calls, []);
  assert.equal(s.heartbeatStable, true);
  assert.equal(s.killSwitchEngaged, false);
});

test("both callers feed the gate from the shared loader; no hardcoded preview inputs", () => {
  const admin = readFileSync(join(SRC, "routes/adminEaHealth.ts"), "utf8");
  const real = readFileSync(join(SRC, "routes/mt5RemoteOps.ts"), "utf8");
  assert.match(admin, /previewEaUpdateGateSafety\(c\.userId, c\.lastHeartbeat, now\)/);
  assert.match(admin, /\.\.\.gateSafety,/);
  // The argument object of each evaluateEaUpdateGate({...}) call.
  const gateCalls = (src: string) => [...src.matchAll(/evaluateEaUpdateGate\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]!);
  const adminCalls = gateCalls(admin);
  const realCalls = gateCalls(real);
  assert.equal(adminCalls.length, 1);
  assert.equal(realCalls.length, 1);
  for (const field of ["killSwitchEngaged", "maintenanceMode", "hasOpenLiveTrade", "hasPendingCommand", "heartbeatStable"]) {
    assert.doesNotMatch(adminCalls[0]!, new RegExp(`\\b${field}\\b`), `adminEaHealth must not set ${field} itself`);
    assert.doesNotMatch(realCalls[0]!, new RegExp(`\\b${field}\\b`), `mt5RemoteOps must not set ${field} itself`);
  }
  assert.match(real, /loadEaUpdateGateSafetyInputs\(userId, conn\.lastHeartbeat\)/);
  assert.match(real, /\.\.\.safety,/);
});
