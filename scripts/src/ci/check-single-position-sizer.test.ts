// Negative fixtures for check-single-position-sizer. Pure, no IO.
import assert from "node:assert/strict";
import { ENGINE, scanFile } from "./check-single-position-sizer.js";

export {};

const ADAPTER = "artifacts/api-server/src/lib/riskGovernor/positionSizer.ts";
const IMPORT = `import { lotForRisk } from "@workspace/domain/risk";\n`;

// The engine itself and files that do not size are ignored.
assert.deepEqual(scanFile(ENGINE, "export function lotForRisk() {}"), []);
assert.deepEqual(scanFile("artifacts/api-server/src/lib/x.ts", "const lot = 1;"), []);

// A listed adapter that delegates passes.
assert.deepEqual(scanFile(ADAPTER, IMPORT + "export function calculatePositionSize() { return lotForRisk(x); }"), []);

// A listed adapter with its own formula (no engine import) fails.
assert.equal(scanFile(ADAPTER, "export function calculatePositionSize(a) { return a.r / a.d; }").length, 1);

// A new sizer file fails even when it imports the engine.
assert.ok(scanFile("artifacts/api-server/src/lib/newSizer.ts", IMPORT + "function computeLotSize() {}")[0]!.includes("outside the sizing engine"));

// Re-implementing the engine's primitives fails.
assert.ok(scanFile(ADAPTER, IMPORT + "function clampLotToStep() {}").some((v) => v.includes("redefines")));

console.log("check-single-position-sizer fixtures: ok");
