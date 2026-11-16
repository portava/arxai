// Learning memory — one owner, never global (Tier 1 finalization, item 8).
//
// strategy_edges and mistake_patterns hold what ARX learned from closed
// trades. Each row has a scope: a trader's private memory, one of their
// strategy / account / broker / instrument / portfolio scopes, or the
// anonymized platform cohort (shown to traders only with enough distinct
// contributors). lib/learning/scopedMemory.ts is the only module that reads or
// writes these tables, so no caller can select the whole table and hand one
// trader another trader's memory. This guard fails when a file outside it:
//   1. names strategyEdgesTable or mistakePatternsTable (drizzle access),
//   2. queries strategy_edges or mistake_patterns in raw SQL.
// QA fixtures (__qa__, *.test.ts) are exempt; scripts under src/scripts are not.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const OWNER = "lib/learning/scopedMemory.ts";

const TABLE = /\b(strategyEdgesTable|mistakePatternsTable)\b/;
const RAW_SQL = /\b(from|join|update|into)\s+"?(strategy_edges|mistake_patterns)"?(?![_\w])/i;

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

/** Violations in one file outside the scoped learning store. */
export function scanForLearningMemoryViolations(src: string): string[] {
  const out: string[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    if (TABLE.test(line)) out.push(`${i + 1}: direct learning-memory table access; use ${OWNER}`);
    else if (RAW_SQL.test(line)) out.push(`${i + 1}: raw SQL on learning memory; use ${OWNER}`);
  });
  return out;
}

export function checkLearningMemorySingleOwner(): CheckResult {
  const violations: string[] = [];
  if (!existsSync(join(API_SRC, OWNER))) violations.push(`artifacts/api-server/src/${OWNER} missing`);
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    if (file.slice(API_SRC.length + 1) === OWNER) continue;
    scanned++;
    for (const v of scanForLearningMemoryViolations(readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "learning-memory-single-owner",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; strategy_edges / mistake_patterns read and written only via ${OWNER}`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLearningMemorySingleOwner();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
