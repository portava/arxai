// Phase 6 — every live command must name its execution venue EXPLICITLY.
//
// WHY THIS GUARD EXISTS. `arx_live_commands.execution_venue` carries a column
// default of 'MT5_EA_BRIDGE'. That default is a BACKFILL FACT: every row created
// before the column existed was bound to an mt5_connection by construction, so
// recording them as MT5 states something already true.
//
// But a column default is indiscriminate. An INSERT that simply forgets the
// venue also silently gets MT5 — which would be a default-to-MT5 through the
// back door, the exact behaviour `routeExecutionVenue` refuses to have. A new
// Deriv command that lost its venue would then be delivered to the MT5 mailbox.
//
// So: the router has no default, and this guard makes sure the column default
// can never stand in for one. Every INSERT into arxLiveCommandsTable must set
// executionVenue explicitly.
//
// Scope note: this checks INSERTs. UPDATEs are not required to restate the
// venue — a command's venue is fixed at creation and must not be rewritten
// afterwards, which the second rule below enforces.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

const SCAN_DIRS = [
  join(ROOT, "artifacts/api-server/src"),
  join(ROOT, "scripts/src"),
];

const TABLE = "arxLiveCommandsTable";

/** Strip comments so prose describing the rule is never mistaken for a breach. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function checkExecutionVenueExplicit(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  let inserts = 0;
  let updates = 0;
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for (const f of walk(dir)) {
      if (!f.endsWith(".ts")) continue;
      // Test files legitimately construct partial rows to exercise refusals.
      if (f.includes("__qa__") || f.endsWith(".test.ts")) continue;
      const src = stripComments(read(f));
      if (!src.includes(TABLE)) continue;
      scanned++;

      // ── Rule 1: every INSERT names the venue. ──────────────────────────
      const insertRe = new RegExp(`db[\\s\\S]{0,40}?\\.insert\\(\\s*${TABLE}\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = insertRe.exec(src)) !== null) {
        inserts++;
        // The values object follows; scan a generous window to its close.
        const after = src.slice(m.index, m.index + 4000);
        const valuesAt = after.indexOf(".values(");
        const region = valuesAt >= 0 ? after.slice(valuesAt, valuesAt + 3000) : after;
        if (!/\bexecutionVenue\s*:/.test(region)) {
          const line = src.slice(0, m.index).split("\n").length;
          violations.push(
            `${rel(f)}:~${line} — INSERT into ${TABLE} does not set executionVenue. ` +
            `The column default would silently bind this command to MT5.`,
          );
        }
      }

      // ── Rule 2: no UPDATE rewrites the venue after creation. ───────────
      // A command's venue is decided once. Rewriting it mid-flight could point
      // an in-flight order at a different broker than the one its gates,
      // approval ticket and exposure reservation were evaluated against.
      const updateRe = new RegExp(`db[\\s\\S]{0,40}?\\.update\\(\\s*${TABLE}\\s*\\)`, "g");
      while ((m = updateRe.exec(src)) !== null) {
        updates++;
        const after = src.slice(m.index, m.index + 4000);
        const setAt = after.indexOf(".set(");
        const region = setAt >= 0 ? after.slice(setAt, setAt + 3000) : after;
        if (/\bexecutionVenue\s*:/.test(region)) {
          const line = src.slice(0, m.index).split("\n").length;
          violations.push(
            `${rel(f)}:~${line} — UPDATE on ${TABLE} rewrites executionVenue. ` +
            `A command's venue is fixed at creation; changing it would point an in-flight ` +
            `order at a broker its gates and approval were never evaluated against.`,
          );
        }
      }
    }
  }

  notes.push(`Scanned ${scanned} file(s) touching ${TABLE}: ${inserts} INSERT site(s), ${updates} UPDATE site(s).`);
  notes.push(
    "Inviolable: the execution_venue column default is a historical backfill, never a runtime " +
    "fallback. routeExecutionVenue has no default and refuses an absent venue.",
  );
  return { name: "execution-venue-explicit", ok: violations.length === 0, violations, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkExecutionVenueExplicit();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
