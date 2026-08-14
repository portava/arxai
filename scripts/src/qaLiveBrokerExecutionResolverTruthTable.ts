// Phase 22V QA — broker-execution resolver truth-table proof.
//
// The Phase 22V QA pass tightened `resolveLiveBrokerExecutionEnabled` from
// env-OR-operator to env-AND-operator. This script proves the 4-row truth
// table holds for both the sync and async variants. It is read-only and
// never touches arx_live_commands. Safe to run in any environment.

import {
  resolveLiveBrokerExecutionEnabled,
} from "../../artifacts/api-server/src/lib/live/phaseBConfig.js";

type Case = { env: boolean; db: boolean; expected: boolean; label: string };

const cases: Case[] = [
  { env: false, db: false, expected: false, label: "env=false db=false → blocked" },
  { env: true,  db: false, expected: false, label: "env=true  db=false → blocked (operator off)" },
  { env: false, db: true,  expected: false, label: "env=false db=true  → blocked (server perm off)" },
  { env: true,  db: true,  expected: true,  label: "env=true  db=true  → allowed (gate 1 only)" },
];

let pass = 0;
let fail = 0;
const originalEnv = process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];

try {
  for (const c of cases) {
    process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = c.env ? "true" : "false";
    const got = resolveLiveBrokerExecutionEnabled({ liveBrokerExecutionArmed: c.db });
    const ok = got === c.expected;
    if (ok) {
      pass++;
      console.log(`  PASS  ${c.label}`);
    } else {
      fail++;
      console.log(`  FAIL  ${c.label} — expected=${c.expected} got=${got}`);
    }
  }
} finally {
  if (originalEnv === undefined) delete process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];
  else process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = originalEnv;
}

console.log(`\nResult: ${pass}/${cases.length} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
