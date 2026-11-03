// The halt the gates read (loadTradingHalt / loadPlatformHalt) is unchanged by
// the status-view report (loadTradingHaltReport / loadPlatformHaltReport,
// b6362d2a, and its unread wording). Every expected value below is what the
// reader returned at 16c8a1a0, before the report existed: same sources, same
// order, same first reason with its detail, and the same fail-closed answer
// for a read that throws. This file runs unchanged against that version.
//
// Consumers that gate on it: riskGovernor/enforce (loadTradingHalt per order),
// selfTrade/decisionEngine and riskGovernor/riskProfile (loadPlatformHalt),
// userReadiness/engine (venueTradingVerdict → loadTradingHalt).
//
// The real tradingHalt reader runs; the install-wide stop and the database are
// stubbed (no connection is made).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/safety/__qa__/tradingHaltGateUnchanged.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");

// Per-trader reads (kill switch row, then allocation row): throw, or return the row.
let traderRead: () => unknown[] = () => [];
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where"]) c[m] = () => c;
  c["limit"] = async () => traderRead();
  return c;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const actualSwitches = await import("../platformSwitches.js");
let emergencyStop: { engaged: boolean; reason: string | null } = { engaged: false, reason: null };
let switchesReadable = true;
let platformThrows = false;
mock.module("../platformSwitches.js", {
  namedExports: {
    ...actualSwitches,
    platformStop: async () => {
      if (platformThrows) {
        // platformStop's own fail-closed answer when a read throws.
        return {
          engaged: true, sources: ["platform_emergency_stop", "safety_core_kill_switch"],
          reason: "The platform emergency stop is engaged by an operator. (state unreadable)",
          detail: { platform_emergency_stop: "state unreadable", safety_core_kill_switch: "state unreadable" },
          readable: false,
        };
      }
      return actualSwitches.platformStopFrom(
        { readable: switchesReadable, emergencyStop: { ...emergencyStop, engagedAt: null } },
        { readable: true, engaged: false, reason: null },
      );
    },
  },
});

const { loadTradingHalt, loadPlatformHalt, NO_HALT } = await import("../tradingHalt.js");

function reset(): void {
  emergencyStop = { engaged: false, reason: null };
  switchesReadable = true;
  platformThrows = false;
  traderRead = () => [];
}

const PES = "The platform emergency stop is engaged by an operator.";
const TKS = "Your kill switch is engaged. Release it to trade again.";

test("nothing engaged: NO_HALT itself", async () => {
  reset();
  assert.equal(await loadTradingHalt({ userId: 7, venue: "LIVE" }), NO_HALT);
  assert.equal(await loadPlatformHalt(), NO_HALT);
});

test("emergency stop + unreadable trader kill switch on LIVE", async () => {
  reset();
  emergencyStop = { engaged: true, reason: "news spike" };
  traderRead = () => { throw new Error("db down"); };
  assert.deepEqual(await loadTradingHalt({ userId: 7, venue: "LIVE" }), {
    engaged: true, sources: ["platform_emergency_stop", "trader_kill_switch"], reason: `${PES} (news spike)`,
  });
  assert.deepEqual(await loadPlatformHalt(), { engaged: true, sources: ["platform_emergency_stop"], reason: `${PES} (news spike)` });
});

test("unreadable switches fail closed with the readers' detail as the first reason", async () => {
  reset();
  switchesReadable = false;
  emergencyStop = { engaged: true, reason: "state unreadable" };
  traderRead = () => { throw new Error("db down"); };
  assert.deepEqual(await loadTradingHalt({ userId: 7, venue: "LIVE" }), {
    engaged: true, sources: ["platform_emergency_stop", "trader_kill_switch"], reason: `${PES} (state unreadable)`,
  });
});

test("a platform-stop read that throws engages both install-wide stops", async () => {
  reset();
  platformThrows = true;
  assert.deepEqual(await loadPlatformHalt(), {
    engaged: true, sources: ["platform_emergency_stop", "safety_core_kill_switch"], reason: `${PES} (state unreadable)`,
  });
});

test("the paper simulator is not halted by the emergency stop; the trader's switch still halts it", async () => {
  reset();
  emergencyStop = { engaged: true, reason: "news spike" };
  assert.equal(await loadTradingHalt({ userId: 7, venue: "PAPER" }), NO_HALT);
  traderRead = () => [{ on: true, why: "taking a break" }];
  assert.deepEqual(await loadTradingHalt({ userId: 7, venue: "PAPER" }), {
    engaged: true, sources: ["trader_kill_switch"], reason: `${TKS} (taking a break)`,
  });
});

test("a close-only shared allocation halts a routed broker order; an unreadable one fails closed", async () => {
  reset();
  traderRead = () => [{ on: false, why: null, status: "active", frozen: false, closeOnly: true }];
  assert.deepEqual(await loadTradingHalt({ userId: 7, venue: "LIVE", virtualAccountId: 5 }), {
    engaged: true, sources: ["allocation_frozen"], reason: "Your shared-account allocation is frozen by an operator. (close-only)",
  });
  // Not routed through a virtual account: the allocation is not read.
  assert.equal(await loadTradingHalt({ userId: 7, venue: "LIVE" }), NO_HALT);
  traderRead = () => { throw new Error("db down"); };
  assert.deepEqual(await loadTradingHalt({ userId: 7, venue: "LIVE", virtualAccountId: 5 }), {
    engaged: true, sources: ["trader_kill_switch", "allocation_frozen"], reason: `${TKS} (state unreadable)`,
  });
});
