// Negative fixtures for check-single-risk-authority. Pure, no IO.
import assert from "node:assert/strict";
import { scanForRiskAuthorityViolations as scan } from "./check-single-risk-authority.js";

export {};

assert.deepEqual(scan("lib/oms.ts", `const r = await enforcePreTradeRisk(intent, opts);`), []);
assert.deepEqual(scan("lib/oms.ts", `// was: preTradeCheck({ ... })`), [], "comments are ignored");
assert.equal(scan("lib/foo.ts", `const acct = preTradeCheck({ symbol });`).length, 1, "retired verdict call");
assert.equal(scan("lib/foo.ts", `const g = await gateForAutopilot();`).length, 1);
assert.equal(scan("routes/x.ts", `import { evaluateRiskCheck } from "../lib/riskGovernorEngine.js";`).length, 1, "retired import");
assert.equal(scan("lib/missionExecution.ts", `const gate = composeMissionGate({ mode });`).length, 1, "mission scope outside the governor");
assert.deepEqual(scan("lib/riskGovernor/missionScope.ts", `const gate = composeMissionGate({ mode });`), []);
assert.equal(scan("lib/paperExecution/x.ts", `import { evaluateReadiness } from "../readiness/traderReadiness.js";`).length, 1,
  "order path may not read the readiness view");
assert.deepEqual(scan("lib/traderCoach/coach.ts", `import { evaluateReadiness } from "../readiness/traderReadiness.js";`), [],
  "the coach may read readiness");
assert.equal(scan("lib/oms.ts", `import { evaluateRisk, marketHealth } from "./marketDataLayer.js";`).length, 1);
assert.equal(scan("lib/newThing.ts", `export async function gateForLiveOrders(x: number) {}`).length, 1, "new verdict export");
assert.deepEqual(scan("lib/tradeAction/riskGovernorEnforcement.ts",
  `export async function enforceRiskGovernor(i: I) {\n  return enforcePreTradeRisk(intent, {});\n}`), [], "adapter that calls the governor");
assert.deepEqual(scan("lib/riskGovernor/enforce.ts", `export async function enforcePreTradeRisk(i: I) {}`), []);

console.log("check-single-risk-authority fixtures: ok");
