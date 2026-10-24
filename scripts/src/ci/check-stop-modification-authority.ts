// Stop modification has one authority (Tier 1 finalization, permanent guard).
//
// A broker position's protection (stop, target, size, closed-at) on the
// position ledgers (live_positions, arx_live_positions) is a broker fact. The
// only way to change it is a governed command (lib/positions/governedOps.ts →
// the venue's draft → confirm → dispatch queue, through the Risk Governor);
// the ledger then follows the broker result or the next snapshot. This guard
// fails when:
//   1. a file outside the broker-truth writers below updates either ledger,
//   2. the reconcile-metadata writer (adminBridgeControl) sets a protective
//      field,
//   3. raw SQL updates either ledger outside the broker-truth writers.
// QA fixtures (__qa__, *.test.ts) and src/scripts (operator one-offs) are exempt.
//
// Pure source analysis: no network, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const LEDGER_UPDATE = /\.\s*update\(\s*(livePositionsTable|arxLivePositionsTable)\s*\)/;
const LEDGER_SQL = /\bupdate\s+(arx_)?live_positions\b/i;
const PROTECTIVE = /\b(stopLoss|takeProfit|closedAt|volume|lotSize)\b/;

/** Files whose ledger writes record what the broker reported. */
export const BROKER_TRUTH_WRITERS: Record<string, string> = {
  "lib/mt5/executionReconciler.ts": "demo/bridge position snapshot",
  "routes/livePositions.ts": "syncFromBroker (Broker Hub feed)",
  "routes/mt5Live.ts": "live position snapshot",
  "lib/live/liveCommandPipeline.ts": "broker result of a governed close",
  "lib/live/brokerAbsenceReconcileRunner.ts": "position absent at the broker",
};
/** Files that may write reconcile metadata, never protection. */
export const METADATA_WRITERS = new Set(["routes/adminBridgeControl.ts"]);

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

export function scanFile(key: string, src: string): string[] {
  if (BROKER_TRUTH_WRITERS[key]) return [];
  const code = stripComments(src);
  const out: string[] = [];
  const lines = code.split("\n");
  lines.forEach((line, i) => {
    if (LEDGER_SQL.test(line)) out.push(`${i + 1}: raw SQL updates a position ledger outside the broker-truth writers`);
    if (!LEDGER_UPDATE.test(line)) return;
    if (!METADATA_WRITERS.has(key)) {
      out.push(`${i + 1}: updates a position ledger; move stops / close through submitGovernedModify / submitGovernedClose`);
    }
  });
  if (METADATA_WRITERS.has(key) && LEDGER_UPDATE.test(code)) {
    // The metadata writer builds its `set` object by name; none of it may be protective.
    const sets = code.match(/(const\s+set\b[^;]*?=\s*\{[\s\S]*?\};|\bset\.\w+\s*=|\.set\(\{[\s\S]*?\}\))/g) ?? [];
    for (const s of sets) if (PROTECTIVE.test(s)) out.push(`reconcile metadata writer sets a protective field: ${s.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  return out;
}

export function checkStopModificationAuthority(): CheckResult {
  const violations: string[] = [];
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue;
    scanned++;
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "stop-modification-authority",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; ${Object.keys(BROKER_TRUTH_WRITERS).length} broker-truth ledger writers`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkStopModificationAuthority();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
