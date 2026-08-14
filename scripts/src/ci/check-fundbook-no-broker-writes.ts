import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// check-fundbook-no-broker-writes — Task #145 regression guard.
//
// The ARX Fund Book is an ACCOUNTING OVERLAY. It may READ broker/bridge state
// (e.g. `mt5ConnectionTable` for equity snapshots, `arxLivePositionsTable` for
// floating-P/L mirroring) but it must NEVER write to any broker/bridge or
// live-execution table. A Drizzle `.insert(...)`, `.update(...)`, or
// `.delete(...)` whose first argument is one of those tables would mean Fund
// Book code can mutate the live execution path — an inviolable safety breach.
//
// This guard fails the build if any source file under
// `artifacts/api-server/src/lib/fundbook/` contains such a write. Reads
// (`.select().from(...)`, joins) are intentionally NOT matched.

const FUNDBOOK_DIR = join(ROOT, "artifacts/api-server/src/lib/fundbook");

// Broker / bridge / live-execution tables the Fund Book must never write to.
const FORBIDDEN_TABLES = new Set([
  "mt5ConnectionTable",
  "mt5CommandsTable",
  "mt5DemoCommandsTable",
  "arxLiveCommandsTable",
  "arxLivePositionsTable",
  "arxLiveArmingTable",
]);

// `.insert/.update/.delete(<ident>` — matched on whitespace-normalized source
// so a call split across lines (`.update(\n  arxLivePositionsTable`) is still
// caught. The captured identifier may be the table OR a local alias of it
// (resolved below).
const WRITE_RE = /\.(insert|update|delete)\(\s*([A-Za-z0-9_$]+)/g;

// Local aliasing of a forbidden table, e.g. `const t = arxLivePositionsTable;`
// or `const { mt5ConnectionTable: c } = schema;` — so `db.update(t)` can't slip
// a write past the direct-identifier check.
const ALIAS_RE = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\b/g;

// Strip line + block comments so commented-out writes don't trip the guard.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function checkFundbookNoBrokerWrites(): CheckResult {
  const files = walk(FUNDBOOK_DIR);
  const violations: string[] = [];

  for (const f of files) {
    const src = stripComments(read(f));
    // Whitespace-normalized copy for multi-line call detection.
    const flat = src.replace(/\s+/g, " ");

    // Build the per-file alias → forbidden-table map first.
    const aliasToTable = new Map<string, string>();
    let a: RegExpExecArray | null;
    const aliasRe = new RegExp(ALIAS_RE.source, "g");
    while ((a = aliasRe.exec(src)) !== null) {
      const local = a[1]!;
      const rhs = a[2]!;
      if (FORBIDDEN_TABLES.has(rhs)) aliasToTable.set(local, rhs);
    }

    const re = new RegExp(WRITE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat)) !== null) {
      const method = m[1]!;
      const target = m[2]!;
      const resolved = FORBIDDEN_TABLES.has(target)
        ? target
        : aliasToTable.get(target);
      if (resolved) {
        const via = resolved === target ? target : `${target} → ${resolved}`;
        violations.push(
          `${rel(f)} → .${method}(${via}) writes a broker/bridge/live table`,
        );
      }
    }
  }

  return {
    name: "fundbook-no-broker-writes",
    ok: violations.length === 0,
    violations,
    notes: [
      `Inspected ${files.length} fundbook source file(s); forbidden write targets: ${[...FORBIDDEN_TABLES].join(", ")}.`,
      "Multi-line calls and local table aliases are resolved; comments are stripped first.",
      "Reads (.select/.from/joins) against broker tables are allowed; only writes are forbidden.",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkFundbookNoBrokerWrites();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
