// One persistence boundary for the two physical position schemas. Runtime
// consumers get rows/columns, never the table objects. Writer access stays
// limited to the existing broker-fact producers; a ledger is not a new way
// for a strategy, Guardian rule, assistant, or accounting overlay to trade.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";
import { BROKER_TRUTH_WRITERS, METADATA_WRITERS } from "./check-stop-modification-authority.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const LEDGER = "lib/positions/ledger.ts";
const TABLES = new Set(["arxLivePositionsTable", "livePositionsTable"]);
const WRITERS = new Set(["livePositionWriter", "demoPositionWriter"]);
const RAW_SQL =
  /\b(?:from|join|update|into|truncate(?:\s+table)?)\s+(?:"?\w+"?\s*\.\s*)?"?(?:arx_)?live_positions"?\b/i;
const PHYSICAL_NAME = /^(?:arx_)?live_positions$/;

export function scanFile(key: string, source: string): string[] {
  if (key === LEDGER) return [];
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  const fail = (node: ts.Node, reason: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.add(`${line}: ${reason}`);
  };
  function visit(node: ts.Node): void {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
    if (name && TABLES.has(name)) fail(node, `direct position table access; use ${LEDGER}`);
    if (name && WRITERS.has(name) && !BROKER_TRUTH_WRITERS[key]) {
      fail(node, "position writers are reserved for broker-fact producers; use governed position operations");
    }
    if (name === "reconcileLivePositionMetadata" && !METADATA_WRITERS.has(key)) {
      fail(node, "operator reconciliation metadata may only be written by the audited reconciliation route");
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (
        RAW_SQL.test(node.text) &&
        (/\b(select|update|insert|delete|truncate)\b/i.test(node.text) || !ts.isStringLiteral(node))
      )
        fail(node, "raw SQL accesses a position table outside the ledger");
      if (
        PHYSICAL_NAME.test(node.text) &&
        ts.isCallExpression(node.parent) &&
        /(?:identifier|raw|tableCount|pgTable)$/.test(node.parent.expression.getText(file))
      ) {
        fail(node, "position table identifier/count must be resolved inside the ledger");
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.exportClause &&
      node.moduleSpecifier &&
      /positions\/ledger(?:\.js)?["']$/.test(node.moduleSpecifier.getText(file))
    ) {
      fail(node, "do not re-export the ledger's restricted writers through a barrel");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "table" &&
      /(?:live|demo)PositionColumns/.test(node.expression.getText(file))
    ) {
      fail(node, "do not recover table objects from position column descriptors");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...violations];
}

export function checkSinglePositionLedger(): CheckResult {
  const violations: string[] = [];
  if (!existsSync(join(API_SRC, LEDGER))) violations.push(`${LEDGER} missing`);
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    // Operator one-offs and QA seed/cleanup are outside runtime authority.
    if (key.startsWith("scripts/")) continue;
    scanned++;
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "single-position-ledger",
    ok: violations.length === 0,
    violations,
    notes: [
      `${scanned} runtime files scanned; two physical tables, one ledger; broker-fact writer boundary preserved`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkSinglePositionLedger();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
