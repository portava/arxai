import { test } from "node:test";
import assert from "node:assert/strict";
import { masterGatePrecedesPhaseB, requireSuiteCommands } from "./sourceContracts.js";
test("required staging commands cannot silently disappear, duplicate, or become empty", () => {
  requireSuiteCommands(["test:required"], { "test:required": "node test.mjs" });
  for (const scripts of [{}, { "test:required": "  " }, { "test:required": false }]) {
    assert.throws(() => requireSuiteCommands(["test:required"], scripts), /Missing required/);
  }
  assert.throws(() => requireSuiteCommands([], {}), /nonempty/);
  assert.throws(() => requireSuiteCommands(["a", "a"], { a: "node test.mjs" }), /unique/);
});
const body = (middle: string) => `export async function dispatchLiveCommand() { ${middle} }`;
const gate = 'if (routingMode === "SHARED_MASTER_MT5") { await loadAndEvaluateMasterLiveBridgeGate(); }';
test("master bridge gate ordering survives unrelated source growth but rejects executable bypasses", () => {
  const long = 'if (routingMode === "SHARED_MASTER_MT5") { /*' + 'safety detail '.repeat(1000) + '*/ await loadAndEvaluateMasterLiveBridgeGate(); }';
  assert.equal(masterGatePrecedesPhaseB(body(`${long} evaluateLivePhaseBDispatchGate({});`)), true);
  for (const invalid of [
    body(`/* ${gate} */ evaluateLivePhaseBDispatchGate({});`),
    body(`await loadAndEvaluateMasterLiveBridgeGate(); evaluateLivePhaseBDispatchGate({});`),
    body(`evaluateLivePhaseBDispatchGate({}); ${gate}`),
    body(`async function uncalled() { ${gate} } evaluateLivePhaseBDispatchGate({});`),
    body(`${gate.replace('await ', '')} evaluateLivePhaseBDispatchGate({});`),
  ]) assert.equal(masterGatePrecedesPhaseB(invalid), false);
});

test("table insertion checks follow transaction writers and ignore comments", async () => {
  const { insertedTables } = await import("./sourceContracts.js");
  assert.deepEqual([...insertedTables('const row = await tx.insert(arxLiveCommandsTable).values({}); // db.insert(mt5DemoCommandsTable)')], ["arxLiveCommandsTable"]);
  assert.ok(insertedTables('await writer.insert(mt5DemoCommandsTable).values({})').has("mt5DemoCommandsTable"));
  assert.equal(insertedTables('const text = "db.insert(arxLiveCommandsTable)";').size, 0);
});
