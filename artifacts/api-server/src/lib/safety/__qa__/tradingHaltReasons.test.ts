// One reason per engaged stop, each with its own detail.
//
// The Control Tower's activeHaltReasons kept the stored detail only for the
// first stop: every later entry was rebuilt from the bare source name. With
// the platform emergency stop engaged and the trader's kill-switch row
// unreadable (it fails closed as engaged), the second reason read "Your kill
// switch is engaged. Release it to trade again." for a switch nobody could
// read, and a trader's own stored kill-switch reason was dropped the same way.
//
// The real tradingHalt reader runs; the install-wide stop and the database
// are stubbed (no connection is made).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/safety/__qa__/tradingHaltReasons.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");

// Per-trader reads: either throw (row unreadable) or return the queued row.
let traderRead: () => unknown[] = () => { throw new Error("db down"); };
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where"]) c[m] = () => c;
  c["limit"] = async () => traderRead();
  return c;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const actualSwitches = await import("../platformSwitches.js");
let emergencyStop: { engaged: boolean; reason: string | null } = { engaged: true, reason: "news spike" };
let switchesReadable = true;
mock.module("../platformSwitches.js", {
  namedExports: {
    ...actualSwitches,
    platformStop: async () => actualSwitches.platformStopFrom(
      { readable: switchesReadable, emergencyStop: { ...emergencyStop, engagedAt: null } },
      { readable: true, engaged: false, reason: null },
    ),
  },
});

const { loadTradingHalt, loadTradingHaltReport, loadPlatformHaltReport } = await import("../tradingHalt.js");

// A switch nobody could read was still worded as a fact ("Your kill switch is
// engaged. Release it to trade again. (state unreadable)"), with an
// instruction that cannot clear a failed read. The status sentence now says
// it could not be read and is treated as engaged (fail closed).
test("a second stop that could not be read says so, not that it is engaged or how to release it", async () => {
  emergencyStop = { engaged: true, reason: "news spike" };
  traderRead = () => { throw new Error("db down"); };
  const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
  assert.deepEqual(report.halt.sources, ["platform_emergency_stop", "trader_kill_switch"]);
  assert.deepEqual(report.reasons, [
    "The platform emergency stop is engaged by an operator. (news spike)",
    "Your kill switch could not be read, so it is treated as engaged (fail closed). No new risk is allowed until it can be read.",
  ]);
  assert.doesNotMatch(report.reasons[1]!, /Release it to trade again|is engaged\./);
});

test("an unreadable platform stop is worded as unread in the status view; the gates' halt.reason is unchanged", async () => {
  switchesReadable = false;
  emergencyStop = { engaged: true, reason: "state unreadable" };
  traderRead = () => { throw new Error("db down"); };
  try {
    const halt = await loadTradingHalt({ userId: 7, venue: "LIVE" });
    const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
    assert.deepEqual(report.halt, halt, "what the gates read is unchanged");
    assert.equal(halt.reason, "The platform emergency stop is engaged by an operator. (state unreadable)");
    assert.deepEqual(report.reasons, [
      "The platform emergency stop could not be read, so it is treated as engaged (fail closed). No new risk is allowed until it can be read.",
      "Your kill switch could not be read, so it is treated as engaged (fail closed). No new risk is allowed until it can be read.",
    ]);
    const platform = await loadPlatformHaltReport();
    assert.deepEqual(platform.reasons, [
      "The platform emergency stop could not be read, so it is treated as engaged (fail closed). No new risk is allowed until it can be read.",
    ]);
  } finally { switchesReadable = true; }
});

test("a trader's own stored kill-switch reason is kept when it is not the first stop", async () => {
  emergencyStop = { engaged: true, reason: null };
  traderRead = () => [{ on: true, why: "taking a break" }];
  const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
  assert.deepEqual(report.reasons, [
    "The platform emergency stop is engaged by an operator.",
    "Your kill switch is engaged. Release it to trade again. (taking a break)",
  ]);
});

test("the halt the gates read is unchanged: same sources, same first reason", async () => {
  emergencyStop = { engaged: true, reason: "news spike" };
  traderRead = () => { throw new Error("db down"); };
  const halt = await loadTradingHalt({ userId: 7, venue: "LIVE" });
  const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
  assert.deepEqual(report.halt, halt);
  assert.deepEqual(Object.keys(halt).sort(), ["engaged", "reason", "sources"]);
  assert.equal(halt.reason, report.reasons[0]);
});

test("a trader's stored reason that happens to read 'state unreadable' is still their reason", async () => {
  emergencyStop = { engaged: false, reason: null };
  traderRead = () => [{ on: true, why: "state unreadable" }];
  const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
  assert.deepEqual(report.reasons, ["Your kill switch is engaged. Release it to trade again. (state unreadable)"]);
});

test("the install-wide report lists one reason per stop", async () => {
  emergencyStop = { engaged: true, reason: "news spike" };
  const report = await loadPlatformHaltReport();
  assert.deepEqual(report.reasons, ["The platform emergency stop is engaged by an operator. (news spike)"]);
});

test("nothing engaged is no reasons", async () => {
  emergencyStop = { engaged: false, reason: null };
  traderRead = () => [];
  const report = await loadTradingHaltReport({ userId: 7, venue: "LIVE" });
  assert.equal(report.halt.engaged, false);
  assert.deepEqual(report.reasons, []);
});
