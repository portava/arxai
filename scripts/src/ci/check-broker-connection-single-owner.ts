// Broker Hub — one owner of broker connection facts (Tier 1 finalization, item 1).
//
// mt5_connection holds each trader's broker account facts: ownership, bridge
// liveness, account number, balance, equity, margin and the bridge token.
// lib/brokerHub/connections.ts is the only module that reads or writes it;
// everyone else calls its named reads (per user, operator, bridge auth) and
// writes. This guard fails when a file outside lib/brokerHub/:
//   1. names mt5ConnectionTable (drizzle access, including type-only use),
//   2. queries mt5_connection in raw SQL,
//   3. reads a bridge token hash (apiKeyHash / previousApiKeyHash) off a
//      connection — callers get `hasBridgeToken` instead.
// QA fixtures (__qa__, *.test.ts) are exempt; scripts under src/scripts are not.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const OWNER = "lib/brokerHub/connections.ts";
export const HUB_DIR = "lib/brokerHub/";

const TABLE = /\bmt5ConnectionTable\b/;
const RAW_SQL = /\b(from|join|update|into)\s+"?mt5_connection"?(?![_\w])/i;
const HASH_READ = /\.\s*(apiKeyHash|previousApiKeyHash)\b/;

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

/** Violations in one file outside the Broker Hub. */
export function scanForBrokerConnectionViolations(src: string): string[] {
  const out: string[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    if (TABLE.test(line)) out.push(`${i + 1}: direct mt5_connection access; use lib/brokerHub/connections.ts`);
    else if (RAW_SQL.test(line)) out.push(`${i + 1}: raw SQL on mt5_connection; use lib/brokerHub/connections.ts`);
    if (HASH_READ.test(line)) out.push(`${i + 1}: reads a bridge token hash; use hasBridgeToken from the Broker Hub`);
  });
  return out;
}

/** Bridge auth needs the hashes; it lives in the hub. Other files may only set them to null on revoke. */
const HASH_WRITE_OK = /\b(apiKeyHash|previousApiKeyHash)\s*:\s*(null|tok\.hash)\b/;

export function checkBrokerConnectionSingleOwner(): CheckResult {
  const violations: string[] = [];
  if (!existsSync(join(API_SRC, OWNER))) violations.push(`artifacts/api-server/src/${OWNER} missing`);
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith(HUB_DIR)) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const v of scanForBrokerConnectionViolations(src)) {
      const lineNo = Number(v.split(":")[0]);
      if (v.includes("token hash") && HASH_WRITE_OK.test(src.split("\n")[lineNo - 1] ?? "")) continue;
      violations.push(`${rel(file)}:${v}`);
    }
  }
  return {
    name: "broker-connection-single-owner",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; mt5_connection read and written only via ${OWNER}`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkBrokerConnectionSingleOwner();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
