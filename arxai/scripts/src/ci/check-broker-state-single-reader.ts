// Broker Hub — one reader for the legacy EA account feed (Tier 1 step 11).
//
// mt5_state is written by the EA bridge ingest (routes/mt5.ts) and read only
// through lib/brokerHub/mt5StateReader.ts, which owns the ownership and
// ordering rules. This guard keeps it that way:
//   1. no file outside the reader and the ingest names mt5StateTable or
//      queries mt5_state in raw SQL,
//   2. the ingest writes the table but never selects from it (it reads its
//      own row back through the hub like everyone else).
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const READER = "lib/brokerHub/mt5StateReader.ts";
export const INGEST = "routes/mt5.ts";

const TABLE = /\bmt5StateTable\b/;
const RAW_SQL = /\b(from|join|update|into)\s+"?mt5_state"?\b/i;
const SELECT = /\.from\(\s*mt5StateTable\s*\)/;

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l)).join("\n");
}

/** Violations for a file outside the reader; `ingest` relaxes rule 1 to writes only. */
export function scanForBrokerStateViolations(src: string, ingest = false): string[] {
  const out: string[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    if (ingest) {
      if (SELECT.test(line)) out.push(`${i + 1}: the ingest reads mt5_state directly; use the Broker Hub reader`);
      return;
    }
    if (TABLE.test(line) || RAW_SQL.test(line)) out.push(`${i + 1}: direct mt5_state access; read it through lib/brokerHub/mt5StateReader.ts`);
  });
  return out;
}

export function checkBrokerStateSingleReader(): CheckResult {
  const violations: string[] = [];
  if (!existsSync(join(API_SRC, READER))) violations.push(`artifacts/api-server/src/${READER} missing`);
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key === READER) continue;
    scanned++;
    for (const v of scanForBrokerStateViolations(readFileSync(file, "utf8"), key === INGEST)) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "broker-state-single-reader",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; mt5_state read only via ${READER}, written only by ${INGEST}`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkBrokerStateSingleReader();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
