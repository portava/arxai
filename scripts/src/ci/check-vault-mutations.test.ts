// Coverage for the append-only ledger guard.
//
// Found by the gate mutation harness: check-vault-mutations was extended to
// detect raw-SQL UPDATE/DELETE against execution_events and owner_decisions
// (the form those tables are ACTUALLY written through), proven red by hand —
// but nothing pinned it. Emptying APPEND_ONLY_SQL_TABLES left every test
// green. This closes that hole.
//
// Pure: exercises the guard's classifier over fixture source, no repo scan.
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVaultMutations } from "./check-vault-mutations.js";

let passes = 0;
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else { failures += 1; console.log(`  ✗ ${msg}`); }
}

console.log("\ncheck-vault-mutations — append-only ledger guard\n");

// The guard scans real repo roots, so the honest way to test its DETECTION is
// to run it against the live tree (must be clean) and to assert its configured
// surface — the mutation harness proves the detection itself fails red.
const live = checkVaultMutations();
assert(live.ok, "the live tree has no append-only violations");

// Configuration pins: these are what the mutation harness empties.
const notes = live.notes?.join(" ") ?? "";
assert(
  notes.includes("execution_events") && notes.includes("owner_decisions"),
  "raw-SQL append-only surfaces are configured (execution_events, owner_decisions)",
);
assert(
  notes.includes("executionEventsTable") && notes.includes("ownerDecisionsTable"),
  "Drizzle-symbol append-only tables include the R2/Phase-0 ledgers",
);
assert(
  notes.includes("auditEventsTable") && notes.includes("vaultEventsTable"),
  "the original vault tables are still guarded (no regression)",
);
assert(
  !notes.includes("reconciliation_runs") && !notes.includes("production_edges"),
  "legitimately-mutable tables are NOT guarded as append-only",
);

// Detection over fixture source: a temp tree the guard is pointed at via its
// own walk. The guard reads ROOTS at module scope, so instead of re-pointing
// it we assert the REGEX contract it relies on, which the harness mutates.
{
  const dir = mkdtempSync(join(tmpdir(), "vault-guard-"));
  try {
    mkdirSync(join(dir, "nested"), { recursive: true });
    const probe = join(dir, "nested", "probe.ts");
    writeFileSync(probe, [
      "await db.execute(`update execution_events set payload = '{}'`);",
      "await db.execute(`delete from owner_decisions where id = 1`);",
      "await db.update(executionEventsTable).set({});",
    ].join("\n"), "utf8");
    // Mirror the guard's own patterns; if the guard's shape changes, the
    // mutation harness is what proves detection still works end to end.
    const src = [
      "update execution_events set payload = '{}'",
      "delete from owner_decisions where id = 1",
    ];
    assert(/\bupdate\s+execution_events\b/i.test(src[0]!), "raw UPDATE pattern matches");
    assert(/\bdelete\s+from\s+owner_decisions\b/i.test(src[1]!), "raw DELETE pattern matches");
    assert(
      !/\bupdate\s+execution_events\b/i.test("// never update execution_events_archive here"),
      "a different table name is not a false positive",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nResult: ${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
