import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const ROOTS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "lib/domain/src"),
];

// Append-only vault tables — UPDATE/DELETE forbidden at the application layer.
// NOTE: safetyCoreTable is intentionally excluded — it is a singleton current-state
// row (one row tracking system mode + kill-switch state), not an event log.
// Mutations to safety_core go through the safetyCore service which writes a
// corresponding append-only event into vault_events / state_transitions.
const VAULT_TABLES = [
  "auditEventsTable",
  "vaultEventsTable",
  "stateTransitionsTable",
  // R2 S2 — the execution evidence log. Late/duplicate/conflicting broker
  // results are RETAINED here as new rows; correcting one by mutation would
  // destroy the very evidence the UNKNOWN reconciler resolves from.
  "executionEventsTable",
  // Blueprint Phase 0 — the owner rulings ledger. Superseding a ruling means
  // appending a new row that names its predecessor, never editing history.
  "ownerDecisionsTable",
  // Phase 6 — the Personal Trading Constitution. A new version is a NEW ROW
  // naming the version it supersedes; editing one in place would retroactively
  // rewrite the rules a user was told governed a trade they already approved.
  // An approval ticket pins constitutionVersion precisely so that record holds.
  "tradingConstitutionsTable",
];

// Raw-SQL append-only surfaces, keyed by physical table name.
//
// WHY BOTH FORMS: the tables above are written through Drizzle symbols, but
// execution_events and owner_decisions are ALSO written via raw parameterized
// SQL (deliberately, to avoid schema-barrel import timing). A guard that only
// matched Drizzle symbols would leave the actual write path unguarded.
//
// DELIBERATELY EXCLUDED — these look similar but legitimately mutate:
//   * reconciliation_runs — opened RUNNING, finalized to COMPLETED/FAILED.
//   * production_edges    — advances rungs (promotedAt) and retires (retiredAt).
const APPEND_ONLY_SQL_TABLES = [
  "execution_events",
  "owner_decisions",
];

const FORBIDDEN_OPS = [
  /\.update\s*\(/,
  /\.delete\s*\(/,
];

export function checkVaultMutations(): CheckResult {
  const violations: string[] = [];
  for (const root of ROOTS) {
    const files = walk(root);
    for (const f of files) {
      const src = read(f);
      // Quick filter: file must reference a vault table to be relevant.
      if (!VAULT_TABLES.some((t) => src.includes(t))
          && !APPEND_ONLY_SQL_TABLES.some((t) => src.includes(t))) continue;
      const lines = src.split("\n");
      // Look for db.update(VAULT_TABLE) / db.delete(VAULT_TABLE) patterns
      // and chained .update(... vaultTable ...) anywhere in a window.
      lines.forEach((line, i) => {
        for (const t of VAULT_TABLES) {
          // Match patterns like: .update(auditEventsTable) or .delete(vaultEventsTable)
          const updateRe = new RegExp(`\\.update\\s*\\(\\s*${t}\\b`);
          const deleteRe = new RegExp(`\\.delete\\s*\\(\\s*${t}\\b`);
          if (updateRe.test(line)) {
            violations.push(`${rel(f)}:${i + 1} → UPDATE on vault table ${t}: ${line.trim().slice(0, 100)}`);
          }
          if (deleteRe.test(line)) {
            violations.push(`${rel(f)}:${i + 1} → DELETE on vault table ${t}: ${line.trim().slice(0, 100)}`);
          }
        }
        // Raw SQL: `update <table> set ...` / `delete from <table>`.
        // Case-insensitive and whitespace-tolerant; comments are skipped so a
        // line documenting the invariant is never itself a violation.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
        for (const t of APPEND_ONLY_SQL_TABLES) {
          const rawUpdate = new RegExp(`\\bupdate\\s+${t}\\b`, "i");
          const rawDelete = new RegExp(`\\bdelete\\s+from\\s+${t}\\b`, "i");
          if (rawUpdate.test(code)) {
            violations.push(`${rel(f)}:${i + 1} → raw UPDATE on append-only table ${t}: ${line.trim().slice(0, 100)}`);
          }
          if (rawDelete.test(code)) {
            violations.push(`${rel(f)}:${i + 1} → raw DELETE on append-only table ${t}: ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }
  }
  return {
    name: "vault-append-only",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inviolable invariant: vault tables (${VAULT_TABLES.join(", ")}) are append-only.`,
      `Raw-SQL append-only surfaces also guarded: ${APPEND_ONLY_SQL_TABLES.join(", ")}.`,
      "DB-layer REVOKE is NOT in force: the app connects as a superuser, which bypasses"
        + " privilege checks, so a REVOKE would assert an immutability the table does not have."
        + " This guard is the enforcement.",
      "Forward-fix via corrective events; never UPDATE or DELETE.",
      `(Note: \`${FORBIDDEN_OPS.map((r) => r.source).join("|")}\` patterns checked.)`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkVaultMutations();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
