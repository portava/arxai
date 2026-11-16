// ARX Handshake System — cross-layer consistency helpers unit tests (PURE).
// Verifies the advisory invariants: no opinions → UNKNOWN (never a fabricated
// CONSISTENT); a single shared value → CONSISTENT/PASS; divergence on a
// required domain → DIVERGENT/BLOCK; divergence on an optional domain → WARN;
// empty/null "no opinion" refs are ignored; symbol comparison is case-folded.
// The helpers are advisory — they NEVER gate execution.
//
// Run: pnpm --filter @workspace/scripts run test:handshake-consistency

import {
  checkConsistency,
  consistencyToOverall,
  checkSelectedSymbolConsistency,
  checkSignalConsistency,
  checkInvestorConsistency,
  checkAdminConsistency,
  CONSISTENCY_STATUSES,
  type ConsistencyRef,
} from "@workspace/domain/handshake";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

console.log("Handshake consistency helpers test");

// 1. No opinions → UNKNOWN (honest; never a fabricated CONSISTENT).
{
  const r = checkConsistency("SIGNAL", []);
  check("empty refs → UNKNOWN", r.status === "UNKNOWN");
  check("empty refs → overall UNKNOWN", consistencyToOverall(r) === "UNKNOWN");

  const allNull: ConsistencyRef[] = [
    { source: "a", value: null },
    { source: "b", value: "" },
    { source: "c", value: "   " },
  ];
  const r2 = checkConsistency("SIGNAL", allNull);
  check("all null/empty/blank → UNKNOWN", r2.status === "UNKNOWN");
}

// 2. Single shared value → CONSISTENT → PASS.
{
  const r = checkSignalConsistency([
    { source: "scanner", value: "sig-123" },
    { source: "explain", value: "sig-123" },
    { source: "ticket", value: "sig-123" },
  ]);
  check("single value → CONSISTENT", r.status === "CONSISTENT");
  check("single value → PASS", consistencyToOverall(r) === "PASS");
  check("single value → no mismatches", r.mismatches.length === 0);
}

// 3. Divergence on a REQUIRED domain → DIVERGENT → BLOCK.
{
  const r = checkSelectedSymbolConsistency([
    { source: "chartBus", value: "EURUSD" },
    { source: "scanner", value: "GBPUSD" },
  ]);
  check("required divergence → DIVERGENT", r.status === "DIVERGENT");
  check("required divergence → BLOCK (advisory)", consistencyToOverall(r) === "BLOCK");
  check("divergence → two distinct values", r.values.length === 2);
  check("divergence → mismatches name the sources", r.mismatches.some((m) => m.sources.includes("chartBus")));
}

// 4. Divergence on an OPTIONAL domain → WARN, never BLOCK.
{
  const r = checkConsistency(
    "SELECTED_SYMBOL",
    [
      { source: "x", value: "EURUSD" },
      { source: "y", value: "USDJPY" },
    ],
    { required: false },
  );
  check("optional divergence → DIVERGENT", r.status === "DIVERGENT");
  check("optional divergence → WARN (never BLOCK)", consistencyToOverall(r) === "WARN");
}

// 5. Selected-symbol comparison is case-folded (EURUSD == eurusd).
{
  const r = checkSelectedSymbolConsistency([
    { source: "bus", value: "EURUSD" },
    { source: "modal", value: "eurusd" },
  ]);
  check("symbol consistency is case-insensitive", r.status === "CONSISTENT");
}

// 6. Null "no opinion" refs are ignored, not treated as a divergent value.
{
  const r = checkInvestorConsistency([
    { source: "fundBook", value: "inv-7" },
    { source: "statement", value: null },
    { source: "portal", value: "inv-7" },
  ]);
  check("null refs ignored → CONSISTENT", r.status === "CONSISTENT");
  check("null refs ignored → single value", r.values.length === 1);
}

// 7. Admin context divergence is required → BLOCK.
{
  const r = checkAdminConsistency([
    { source: "session", value: "owner-1" },
    { source: "auditActor", value: "admin-9" },
  ]);
  check("admin divergence → BLOCK", consistencyToOverall(r) === "BLOCK");
}

// 8. Status never escapes the allowed set.
{
  const samples: ConsistencyRef[][] = [
    [],
    [{ source: "a", value: "x" }],
    [{ source: "a", value: "x" }, { source: "b", value: "y" }],
  ];
  const allValid = samples.every((s) =>
    (CONSISTENCY_STATUSES as readonly string[]).includes(checkConsistency("SIGNAL", s).status),
  );
  check("status always within allowed set", allValid);
}

if (failures > 0) {
  console.error(`\nHandshake consistency test FAILED (${failures} failures)`);
  process.exit(1);
}
console.log("\nHandshake consistency test passed");
export {};
