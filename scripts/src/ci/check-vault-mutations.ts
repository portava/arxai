import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const ROOTS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "lib/domain/src"),
  // Phase 6 — lib/db/src was NOT scanned before, which left the guard blind in
  // the one directory where an append-only violation is most likely to be
  // written: the repositories are here, and a repository is where an UPDATE
  // gets added. Every vault table's write path lives under this root, so
  // omitting it meant the "inviolable invariant" was enforced everywhere except
  // the code that actually does the writing. Found by injecting a real UPDATE
  // on tradingConstitutionsTable into a repository and watching the guard pass.
  join(ROOT, "lib/db/src"),
  // Phase 6 guard-scope audit — scripts/src was unscanned, and 131 files under
  // it import @workspace/db. An ops or QA script can write anything, and a
  // one-off "fix the ledger" script is exactly how an append-only table gets
  // quietly mutated. artifacts/api-server/__qa__ is a sibling of src and was
  // outside the root for the same reason.
  join(ROOT, "scripts/src"),
  // artifacts/api-server/__qa__ is a SIBLING of src, so it fell outside the
  // root above. It already hosts real mutation code (phase27b-extended-rules.ts
  // updates and deletes four tables), and it is the established home for
  // api-server QA scenarios that drive the DB directly. Coverage turned on a
  // directory choice an author has no reason to think about.
  join(ROOT, "artifacts/api-server/__qa__"),
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
  // Phase 6 guard-scope audit — both are append-only hash-chained ledgers that
  // were absent from this list entirely. event_log computes its row_hash IN
  // POSTGRES and security_events serialises writes under an advisory lock;
  // mutating either breaks the chain that makes the ledger evidence at all.
  "eventLogTable",
  "securityEventsTable",
  // Phase 6 — the guided forensic ledger. Mutating a row would rewrite what a
  // trade attempt actually did, which is the only thing this table is for.
  "guidedAttemptEventsTable",
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
  // The Drizzle-symbol branch only matches the SYMBOL. Raw parameterized SQL is
  // an established write path here (the guard's own comment above explains why),
  // so the same edit in raw form was waved through in the same file that would
  // have been caught in Drizzle form.
  "trading_constitutions",
  "event_log",
  "security_events",
];

const FORBIDDEN_OPS = [
  /\.update\s*\(/,
  /\.delete\s*\(/,
];

/**
 * Files allowed to mutate a vault table, each for a NAMED reason.
 *
 * A blanket "skip anything called *Test.ts" exclusion would hide a real
 * violation in any file someone happened to name that way. These three are
 * listed individually so adding a fourth is a visible, reviewable edit.
 *
 * securityChainTest is the important one: it MUTATES a chained row ON PURPOSE
 * to prove the hash chain detects tampering. A guard that forbade this would
 * prevent proving the ledger works at all — the guard would be protecting the
 * chain by making it untestable.
 */
const TAMPER_PROOF_HARNESSES: Readonly<Record<string, string>> = {
  "scripts/src/securityChainTest.ts":
    "deliberately tampers with a chained row to prove the hash chain detects it, and deletes its own synthetic actor",
  "scripts/src/eventLogDbTest.ts":
    "deliberately tampers with a chained row to prove in-Postgres row_hash verification detects it; deletes only its own QA_ rows",
  "scripts/src/qaSharedBridgeAttachFlow.ts":
    "QA flow that deletes ONLY the synthetic actor's own security events during teardown",
};

export function checkVaultMutations(): CheckResult {
  const violations: string[] = [];
  for (const root of ROOTS) {
    const files = walk(root);
    for (const f of files) {
      // scripts/src/ci holds the GUARDS THEMSELVES and their fixtures. A guard
      // necessarily quotes the pattern it forbids, and its tests necessarily
      // contain violating strings as test data — scanning them reports the
      // guard's own documentation as a breach. Excluded deliberately, not
      // because it is inconvenient: no application DB write lives here.
      if (rel(f).startsWith("scripts/src/ci/")) continue;
      if (TAMPER_PROOF_HARNESSES[rel(f)]) continue;
      const src = read(f);
      // Quick filter: file must reference a vault table to be relevant.
      if (!VAULT_TABLES.some((t) => src.includes(t))
          && !APPEND_ONLY_SQL_TABLES.some((t) => src.includes(t))) continue;
      // Prettier wraps a long call as `db.update(\n  tableSymbol,\n)`, and
      // `import * as schema` makes `schema.tableSymbol` a valid spelling. Both
      // are invisible to a per-line regex. Scan the comment-stripped whole file
      // with a newline-tolerant pattern as well, and de-duplicate against the
      // per-line findings below.
      const whole = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const t of VAULT_TABLES) {
        const multi = new RegExp(`\\.(update|delete)\\s*\\(\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?${t}\\b`, "g");
        let mm: RegExpExecArray | null;
        while ((mm = multi.exec(whole)) !== null) {
          const lineNo = whole.slice(0, mm.index).split("\n").length;
          const msg = `${rel(f)}:${lineNo} → ${mm[1]!.toUpperCase()} on vault table ${t} (multiline/aliased form)`;
          if (!violations.some((v) => v.startsWith(`${rel(f)}:${lineNo} →`))) violations.push(msg);
        }
      }
      const lines = src.split("\n");
      // Look for db.update(VAULT_TABLE) / db.delete(VAULT_TABLE) patterns
      // and chained .update(... vaultTable ...) anywhere in a window.
      lines.forEach((rawLine, i) => {
        // Strip comments FIRST, for BOTH branches below. The raw-SQL branch
        // already skipped them; the Drizzle-symbol branch did not, so this
        // guard's own comment describing ".update(auditEventsTable)" was
        // reported as a violation of itself once the scan roots widened.
        const line = rawLine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "");
        if (line.trim() === "") return;
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
