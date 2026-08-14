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
      if (!VAULT_TABLES.some((t) => src.includes(t))) continue;
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
      });
    }
  }
  return {
    name: "vault-append-only",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inviolable invariant: vault tables (${VAULT_TABLES.join(", ")}) are append-only.`,
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
