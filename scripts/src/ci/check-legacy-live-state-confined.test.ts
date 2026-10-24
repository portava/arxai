// Negative fixtures for check-legacy-live-state-confined. Pure, no IO.
import assert from "node:assert/strict";
import { scanFile } from "./check-legacy-live-state-confined.js";

export {};

assert.deepEqual(scanFile("lib/liveTrading/state.ts", "db.select().from(liveTradingStateTable)"), []);
assert.equal(scanFile("lib/userReadiness/engine.ts", "db.select().from(liveTradingStateTable)").length, 1);
assert.deepEqual(scanFile("lib/safety/tradingHalt.ts", "// live_trading_state.kill_switch_active  legacy path"), [], "a comment naming the table is fine");

console.log("check-legacy-live-state-confined fixtures: ok");
