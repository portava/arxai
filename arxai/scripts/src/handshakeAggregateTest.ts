// ARX Handshake System — aggregation engine unit tests (PURE, no DB).
// Verifies the advisory invariants: empty/all-SKIPPED → UNKNOWN (never a
// fabricated PASS); all-PASS → PASS; a REQUIRED NOT_AVAILABLE/FAIL → BLOCK;
// REQUIRED WARN → WARN; an OPTIONAL down → WARN only; SKIPPED is ignored; and
// that the verdict never escapes the four allowed values. The engine is
// advisory — it is NOT an execution gate.
//
// Run: pnpm --filter @workspace/scripts run test:handshake-aggregate

import {
  aggregateHandshake,
  HANDSHAKE_OVERALL_STATUSES,
  type HandshakeLayerCheck,
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

const chk = (over: Partial<HandshakeLayerCheck> = {}): HandshakeLayerCheck => ({
  layer: "MARKET_DATA",
  status: "PASS",
  required: true,
  detail: "",
  ageMs: null,
  ...over,
});

console.log("Handshake aggregation engine test");

// 1. No checks → UNKNOWN (honest; never a fabricated PASS).
{
  const r = aggregateHandshake([]);
  check("empty → UNKNOWN", r.overallStatus === "UNKNOWN");
  check("empty → not safeToProceed", r.safeToProceed === false);
  check("empty → no blockers", r.blockers.length === 0);
  check("empty → no warnings", r.warnings.length === 0);
}

// 2. All required layers PASS → PASS.
{
  const r = aggregateHandshake([chk(), chk({ layer: "BROKER_BRIDGE" })]);
  check("all PASS → PASS", r.overallStatus === "PASS");
  check("all PASS → safeToProceed", r.safeToProceed === true);
  check("all PASS → no blockers/warnings", r.blockers.length === 0 && r.warnings.length === 0);
}

// 3. A REQUIRED NOT_AVAILABLE layer → BLOCK with a blocker.
{
  const r = aggregateHandshake([
    chk(),
    chk({ layer: "INVESTOR_FUND_BOOK", status: "NOT_AVAILABLE", detail: "fund book read failed" }),
  ]);
  check("required NOT_AVAILABLE → BLOCK", r.overallStatus === "BLOCK");
  check("required NOT_AVAILABLE → not safeToProceed", r.safeToProceed === false);
  check("required NOT_AVAILABLE → blocker captured", r.blockers.length === 1);
  check(
    "blocker includes layer + status + detail",
    r.blockers[0].includes("INVESTOR_FUND_BOOK") &&
      r.blockers[0].includes("NOT_AVAILABLE") &&
      r.blockers[0].includes("fund book read failed"),
  );
}

// 3b. A REQUIRED FAIL layer → BLOCK (definitive bad state).
{
  const r = aggregateHandshake([chk({ layer: "KILL_SWITCH", status: "FAIL", detail: "kill switch engaged" })]);
  check("required FAIL → BLOCK", r.overallStatus === "BLOCK");
  check("required FAIL → blocker captured", r.blockers.length === 1);
}

// 4. A REQUIRED WARN layer → WARN (not BLOCK).
{
  const warn = aggregateHandshake([chk({ status: "WARN" })]);
  check("required WARN → WARN", warn.overallStatus === "WARN");
  check("required WARN → warning captured, no block", warn.warnings.length === 1 && warn.blockers.length === 0);
  check("required WARN → safeToProceed (advisory, no blockers)", warn.safeToProceed === true);
}

// 5. An OPTIONAL NOT_AVAILABLE layer → WARN only (never BLOCK).
{
  const r = aggregateHandshake([
    chk(),
    chk({ layer: "MARKET_DATA", required: false, status: "NOT_AVAILABLE" }),
  ]);
  check("optional NOT_AVAILABLE → WARN (advisory, never BLOCK)", r.overallStatus === "WARN");
  check("optional NOT_AVAILABLE → warning, not blocker", r.warnings.length === 1 && r.blockers.length === 0);
}

// 6. BLOCK dominates WARN when both present.
{
  const r = aggregateHandshake([
    chk({ status: "WARN" }),
    chk({ layer: "ADMIN_CONTROL", status: "NOT_AVAILABLE" }),
  ]);
  check("block dominates warn", r.overallStatus === "BLOCK");
  check("both blocker + warning captured", r.blockers.length === 1 && r.warnings.length === 1);
}

// 7. SKIPPED is ignored: all-SKIPPED → UNKNOWN; SKIPPED alongside PASS → PASS.
{
  const allSkipped = aggregateHandshake([chk({ status: "SKIPPED" }), chk({ layer: "ADMIN_CONTROL", status: "SKIPPED" })]);
  check("all SKIPPED → UNKNOWN", allSkipped.overallStatus === "UNKNOWN");
  check("all SKIPPED → no blockers/warnings", allSkipped.blockers.length === 0 && allSkipped.warnings.length === 0);

  const mixed = aggregateHandshake([chk(), chk({ layer: "ADMIN_CONTROL", status: "SKIPPED" })]);
  check("PASS + SKIPPED → PASS", mixed.overallStatus === "PASS");
}

// 8. Verdict never escapes the four allowed values.
{
  const samples: HandshakeLayerCheck[][] = [
    [],
    [chk()],
    [chk({ status: "WARN" })],
    [chk({ status: "NOT_AVAILABLE" })],
    [chk({ status: "FAIL" })],
    [chk({ status: "SKIPPED" })],
    [chk({ required: false, status: "WARN" })],
  ];
  const allValid = samples.every((s) =>
    (HANDSHAKE_OVERALL_STATUSES as readonly string[]).includes(aggregateHandshake(s).overallStatus),
  );
  check("verdict always within allowed set", allValid);
}

if (failures > 0) {
  console.error(`\nHandshake aggregation test FAILED (${failures} failures)`);
  process.exit(1);
}
console.log("\nHandshake aggregation test passed");
export {};
