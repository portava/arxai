// Negative fixtures for check-execution-single-entry: the write detector and
// the lifecycle exposure check. Pure, no IO.
import assert from "node:assert/strict";
import { exposureKeysIn, findWrites, setBlockAfter } from "./check-execution-single-entry.js";

export {};

// Writes are found on every execution table, reads are not.
assert.equal(findWrites(`await db.select().from(mt5CommandsTable)`).length, 0);
assert.deepEqual(findWrites(`await db.insert(paperOrdersTable).values({})`).map((w) => w.table), ["paperOrdersTable"]);
assert.deepEqual(findWrites(`tx.update( arxLiveCommandsTable ).set({ status: "X" })`).map((w) => w.op), ["update"]);
assert.equal(findWrites(`db.delete(mt5DemoCommandsTable)`).length, 1);

// A status-only lifecycle update passes.
const ok = `await db.update(mt5CommandsTable).set({ status: "EXPIRED", detail: { sl: 1 }, updatedAt: now }).where(x)`;
assert.deepEqual(exposureKeysIn(setBlockAfter(ok, 0)!), [], "nested keys are not top-level writes");

// A lifecycle update that moves a stop is caught, literal or via a patch variable.
const widen = `await db.update(arxLiveCommandsTable).set({ status: "LIVE_APPROVED", stopLoss: 1.08 })`;
assert.deepEqual(exposureKeysIn(setBlockAfter(widen, 0)!), ["stopLoss"]);
const viaPatch = `const patch: P = { status: "DONE" };\npatch.takeProfit = 2;\nawait db.update(mt5DemoCommandsTable).set(patch).where(y)`;
assert.deepEqual(exposureKeysIn(setBlockAfter(viaPatch, viaPatch.indexOf("db.update"))!), ["takeProfit"]);

// An unresolvable .set() argument is reported as unprovable (null).
assert.equal(setBlockAfter(`await db.update(mt5CommandsTable).set(buildPatch(x))`, 0), null);

console.log("check-execution-single-entry fixtures: ok");
