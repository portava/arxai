// The admin EA-health update preview reads the same gate inputs as the EA's
// real update check (GET /mt5/update-check). Before, the preview hardcoded the
// trader kill switch, maintenance mode and open-trade inputs to false, so it
// could say "update allowed" where the EA's real check blocked.
//
// Round 5 (owner decision 5): either install-wide stop (platform emergency
// stop or safety-core kill switch) blocks automatic EA updates, read last,
// with every existing check kept and no bypass; the preview still runs.
//
// The DB reads are injected, except the last test, which engages the real
// stops through platformStop() on the test database and restores them.

import { after, test } from "node:test";
import { asc } from "drizzle-orm";
import { db, globalTradingSettingsTable, safetyCoreTable } from "@workspace/db";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateEaUpdateGate } from "@workspace/domain/safety-contracts";
import {
  dbEaUpdateGateReaders,
  loadEaUpdateGateSafetyInputs,
  previewEaUpdateGateSafety,
  isHeartbeatStableForEaUpdate,
  type EaUpdateGateReaders,
} from "../eaUpdateGateInputs.js";
import { MT5_HEARTBEAT_FRESH_BELOW_MS } from "../../brokerHub/freshness.js";

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
    platformStopEngaged: async () => {
      calls.push("platformStopEngaged");
      return state.platformStopEngaged ?? false;
    },
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
  assert.deepEqual(s, { hasOpenLiveTrade: false, hasPendingCommand: false, heartbeatStable: true, killSwitchEngaged: false, platformStopEngaged: false, maintenanceMode: false });
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
  assert.deepEqual(calls, ["killSwitchEngaged:42", "hasOpenLiveTrade:42", "hasPendingCommand:42", "maintenanceMode:42", "platformStopEngaged"]);
});

test("heartbeat stability is the shared policy's fresh band (age < 15 s, owner decision 17)", () => {
  const now = NOW.getTime();
  assert.equal(MT5_HEARTBEAT_FRESH_BELOW_MS, 15_000);
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now - 14_999), now), true);
  // Was stable at exactly 15 000 ms (<= 15 s); the policy is strictly < 15 s.
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now - 15_000), now), false);
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now - 15_001), now), false);
  assert.equal(isHeartbeatStableForEaUpdate(null, now), false);
  // A future-dated heartbeat is "unknown", never stable.
  assert.equal(isHeartbeatStableForEaUpdate(new Date(now + 1_000), now), false);
  assert.equal(isHeartbeatStableForEaUpdate(new Date(Number.NaN), now), false);
});

test("a userless connection reads no trader state (only the install-wide stops)", async () => {
  const calls: string[] = [];
  const s = await previewEaUpdateGateSafety(null, freshHb, NOW, readers({ killSwitchEngaged: true }, calls));
  assert.deepEqual(calls, ["platformStopEngaged"]);
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
  for (const field of ["killSwitchEngaged", "platformStopEngaged", "maintenanceMode", "hasOpenLiveTrade", "hasPendingCommand", "heartbeatStable"]) {
    assert.doesNotMatch(adminCalls[0]!, new RegExp(`\\b${field}\\b`), `adminEaHealth must not set ${field} itself`);
    assert.doesNotMatch(realCalls[0]!, new RegExp(`\\b${field}\\b`), `mt5RemoteOps must not set ${field} itself`);
  }
  assert.match(real, /loadEaUpdateGateSafetyInputs\(userId, conn\.lastHeartbeat\)/);
  assert.match(real, /\.\.\.safety,/);
});

// ── Round 5, owner decision 5: install-wide stops block automatic EA updates ──

test("either install-wide stop blocks the update; every existing check is kept; the preview still reports", async () => {
  const s = await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ platformStopEngaged: true }));
  assert.equal(s.platformStopEngaged, true);
  assert.deepEqual([gate(s).decision, gate(s).reason], ["BLOCK", "PLATFORM_STOP_ENGAGED"], "diagnostics/preview still run and name the reason");
  // The trader's own kill switch keeps its reason first; other checks still block on their own.
  assert.equal(gate(await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ platformStopEngaged: true, killSwitchEngaged: true }))).reason, "KILL_SWITCH_ENGAGED");
  for (const k of ["maintenanceMode", "hasOpenLiveTrade", "hasPendingCommand"] as const) {
    assert.equal(gate(await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ [k]: true }))).decision, "BLOCK", `${k} still blocks with the stops released`);
  }
  assert.equal(gate(await previewEaUpdateGateSafety(7, new Date(NOW.getTime() - 60_000), NOW, readers({}))).reason, "HEARTBEAT_UNSTABLE");
  // A userless row is install-wide too.
  assert.equal(gate(await previewEaUpdateGateSafety(null, freshHb, NOW, readers({ platformStopEngaged: true }))).reason, "PLATFORM_STOP_ENGAGED");
  // No bypass: the gate input has no override, and released stops allow again.
  assert.equal(gate(await previewEaUpdateGateSafety(7, freshHb, NOW, readers({ platformStopEngaged: false }))).decision, "ALLOW");
});

const savedGts = await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
const savedCore = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id));
after(async () => {
  await db.delete(globalTradingSettingsTable);
  if (savedGts.length) await db.insert(globalTradingSettingsTable).values(savedGts);
  await db.delete(safetyCoreTable);
  if (savedCore.length) await db.insert(safetyCoreTable).values(savedCore);
});

test("the real reader: each install-wide stop, read through platformStop(), blocks the update", async () => {
  await db.delete(globalTradingSettingsTable);
  await db.insert(globalTradingSettingsTable).values({});
  await db.delete(safetyCoreTable);
  await db.insert(safetyCoreTable).values({});
  assert.equal(await dbEaUpdateGateReaders.platformStopEngaged(), false, "released");
  await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true, killSwitchReason: "qa ea" });
  assert.equal(await dbEaUpdateGateReaders.platformStopEngaged(), true, "platform emergency stop");
  await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: false, killSwitchReason: null });
  await db.update(safetyCoreTable).set({ killSwitchEngaged: true, killSwitchReason: "qa ea" });
  assert.equal(await dbEaUpdateGateReaders.platformStopEngaged(), true, "safety-core kill switch");
  await db.update(safetyCoreTable).set({ killSwitchEngaged: false, killSwitchReason: null });
  assert.equal(await dbEaUpdateGateReaders.platformStopEngaged(), false);
});
