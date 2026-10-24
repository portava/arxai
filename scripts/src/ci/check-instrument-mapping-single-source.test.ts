// Negative fixtures for check-instrument-mapping-single-source. Pure, no IO.
import assert from "node:assert/strict";
import { scanForMappingViolations } from "./check-instrument-mapping-single-source.js";

export {};

assert.deepEqual(scanForMappingViolations(`import { resolveInstrument } from "../lib/instruments/index.js";`), []);
assert.deepEqual(scanForMappingViolations(`// const CANONICAL_ALIASES = {}`), [], "comments are ignored");
assert.equal(scanForMappingViolations(`const CANONICAL_ALIASES: Record<string,string> = { GOLD: "XAUUSD" };`).length, 1);
assert.equal(scanForMappingViolations(`export function resolveCanonicalSymbol(s: string) {}`).length, 1);
assert.equal(scanForMappingViolations(`await db.select({ b: symbolsTable.brokerSymbol }).from(symbolsTable)`).length, 1);
assert.equal(scanForMappingViolations(`import { compactSymbolKey } from "../instruments/brokerSymbolName.js";`).length, 1);
assert.equal(scanForMappingViolations(`const m = await import("../../lib/instruments/canonicalSymbol.js");`).length, 1);

console.log("check-instrument-mapping-single-source fixtures: ok");
