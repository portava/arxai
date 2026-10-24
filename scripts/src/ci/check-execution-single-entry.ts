// ── Trade Engine single entry: no ungoverned order writers (Tier 1 step 6) ──
//
// ORIGIN → TRADE ACTION → RISK GOVERNOR → EXECUTION ROUTER → VENUE/BROKER →
// FILL → POSITION GUARDIAN → AUDIT.
//
// Every file in artifacts/api-server/src that INSERTs, UPDATEs or DELETEs an
// execution table (order and command queues, the paper order ledger) must be
// listed below with its role, and the listed proof must still be in the code:
//
//   GOVERNED   — creates or changes exposure (open, modify, close). Proof: the
//                pre-trade Risk Governor (enforcePreTradeRisk) is called in
//                the file, or in the named file that gates it.
//   LIFECYCLE  — moves a command or order through its states (claim, result,
//                cancel, expire, reconcile). Its .update(...).set({...})
//                blocks may not touch size, side, symbol, stop or target.
//   NON_TRADE  — writes a queue row that cannot trade (forced BLOCKED, a
//                read-only EA request, a reconnect). Proof: the pinned line.
//   QA_SCRIPT  — operator/QA scripts under src/scripts, not served by the API.
//
// A new writer file fails until it is classified here, which is the review
// point the directive asks for. The simulator OMS keeps its book in memory;
// its raw mutators must stay unexported (only governed entry points).
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");

export const EXECUTION_TABLES = [
  "arxLiveCommandsTable", "mt5DemoCommandsTable", "mt5CommandsTable", "paperOrdersTable",
] as const;

type Role = "GOVERNED" | "LIFECYCLE" | "NON_TRADE" | "QA_SCRIPT";
type Entry = { role: Role; proof?: RegExp; proofFile?: string; why: string };

const GOVERNOR = /\benforcePreTradeRisk\s*\(/;

export const WRITERS: Record<string, Entry> = {
  // GOVERNED
  "lib/live/liveCommandPipeline.ts": { role: "GOVERNED", proof: GOVERNOR, why: "live drafts; dispatchLiveCommand pre-gate, then the EA bridge mirror" },
  "lib/mt5/demoCommandQueue.ts": { role: "GOVERNED", proof: GOVERNOR, proofFile: "lib/mt5/demoCommandConsumer.ts", why: "demo drafts; governed when consumed" },
  "lib/mt5/demoCommandConsumer.ts": { role: "GOVERNED", proof: GOVERNOR, why: "demo consumer: governor before dispatch" },
  "lib/adminTrading/brokerPlacement.ts": { role: "GOVERNED", proof: GOVERNOR, proofFile: "lib/adminTrading/orderGuard.ts", why: "admin placement behind orderGuard gate 9b" },
  "lib/paperExecution/paperExecutionService.ts": { role: "GOVERNED", proof: GOVERNOR, why: "paper execution open" },
  "lib/paperExecution/paperExecutionMonitor.ts": { role: "GOVERNED", proof: GOVERNOR, why: "manual close governed; SL/TP hits are venue fills" },
  "routes/paperTrading.ts": { role: "GOVERNED", proof: GOVERNOR, why: "paper ledger open/modify/close; SL/TP hits are venue fills" },
  "routes/autoDebrief.ts": { role: "GOVERNED", proof: GOVERNOR, why: "operator QA fixture order" },
  "routes/demoExecution.ts": { role: "GOVERNED", proof: GOVERNOR, why: "legacy demo market order" },
  "routes/meTrades.ts": { role: "GOVERNED", proof: GOVERNOR, why: "demo close" },
  // LIFECYCLE
  "lib/live/liveCommandCas.ts": { role: "GOVERNED", proof: GOVERNOR, proofFile: "lib/live/liveCommandPipeline.ts", why: "compare-and-set claims used only inside the governed live pipeline" },
  "lib/live/unknownReconciler.ts": { role: "LIFECYCLE", why: "resolves UNKNOWN live outcomes" },
  "lib/mt5/demoCommandReconciler.ts": { role: "LIFECYCLE", why: "demo outcome reconciliation" },
  "lib/mt5/executionReconciler.ts": { role: "LIFECYCLE", why: "EA result reconciliation" },
  "lib/mt5/stuckCommandWatchdog.ts": { role: "LIFECYCLE", why: "expires stuck commands" },
  "routes/adminLiveSharedActivation.ts": { role: "LIFECYCLE", why: "admin rollback / stale cancel" },
  "routes/adminTrading.ts": { role: "LIFECYCLE", why: "admin cancel / needs-review" },
  "routes/tradesLiveShared.ts": { role: "LIFECYCLE", why: "blocks a draft whose attribution failed" },
  "routes/meMt5Commands.ts": { role: "NON_TRADE", proof: /const SAFE_ACTIONS = new Set\(/, why: "allow-listed read-only EA requests; user cancel" },
  // NON_TRADE
  "routes/mt5.ts": { role: "NON_TRADE", proof: /const status = "BLOCKED" as const;/, why: "legacy queue forced BLOCKED; EA claim/result are lifecycle" },
  "routes/brokerHealth.ts": { role: "NON_TRADE", proof: /action: "RECONNECT"/, why: "operator reconnect request" },
  // QA_SCRIPT
  "scripts/demoDispatch3aQa.ts": { role: "QA_SCRIPT", why: "QA seed" },
  "scripts/phase-ux1-trades-test.ts": { role: "QA_SCRIPT", why: "QA cleanup" },
  "scripts/phase-ux9-multi-user-seed-test.ts": { role: "QA_SCRIPT", why: "QA seed" },
  "scripts/phase3-demo-dryrun.ts": { role: "QA_SCRIPT", why: "QA dry run" },
  "scripts/phase35-routing-test.ts": { role: "QA_SCRIPT", why: "QA cleanup" },
};

/** Exposure-defining columns a lifecycle update may never set. */
const EXPOSURE_KEYS = ["sl", "tp", "lot", "side", "symbol", "stopLoss", "takeProfit", "requestedVolume", "lotSize", "direction", "entryPrice"];

const OMS_RAW = ["createOrder", "patchOrder", "cancelOrder", "submitToSimulator", "closePosition",
  "partialClose", "moveStop", "moveTakeProfit", "moveStopToBreakEven", "applyTrailingStop"];

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => {
    const i = l.search(/(^|[^:"'`])\/\//);
    return i >= 0 ? l.slice(0, i + (l[i] === "/" ? 0 : 1)) : l;
  }).join("\n");
}

const WRITE_RX = new RegExp(`\\.(insert|update|delete)\\(\\s*(${EXECUTION_TABLES.join("|")})\\s*\\)`, "g");

export function findWrites(src: string): { op: string; table: string; index: number }[] {
  const out: { op: string; table: string; index: number }[] = [];
  for (const m of src.matchAll(WRITE_RX)) out.push({ op: m[1]!, table: m[2]!, index: m.index! });
  return out;
}

function balanced(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/**
 * The object passed to the .set( that follows an update, or null. A local
 * patch variable (`.set(patch)`) is resolved to its literal plus any
 * `patch.key =` assignments in the same file.
 */
export function setBlockAfter(src: string, from: number): string | null {
  const s = src.indexOf(".set(", from);
  if (s < 0 || s - from > 200) return null;
  const arg = src.slice(s + 5).match(/^\s*(\{|[A-Za-z_$][\w$]*\s*\))/);
  if (!arg) return null;
  if (arg[1] === "{") return balanced(src, src.indexOf("{", s));
  const name = arg[1]!.replace(/\s*\)$/, "");
  const decl = new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*\\{`).exec(src);
  if (!decl) return null;
  const lit = balanced(src, decl.index + decl[0].length - 1);
  if (!lit) return null;
  const assigned = [...src.matchAll(new RegExp(`\\b${name}\\.(\\w+)\\s*=`, "g"))].map((m) => `${m[1]}: x`);
  return `{${lit.slice(1, -1)}${assigned.length ? ", " + assigned.join(", ") : ""}}`;
}

export function exposureKeysIn(block: string): string[] {
  // Top-level keys only: drop nested objects first.
  let flat = block.slice(1, -1);
  let prev = "";
  while (prev !== flat) { prev = flat; flat = flat.replace(/\{[^{}]*\}/g, "{}"); }
  return EXPOSURE_KEYS.filter((k) => new RegExp(`(^|[\\s,])${k}\\s*:`).test(flat));
}

export function checkExecutionSingleEntry(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const counts: Record<Role, number> = { GOVERNED: 0, LIFECYCLE: 0, NON_TRADE: 0, QA_SCRIPT: 0 };

  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const src = stripComments(readFileSync(file, "utf8"));
    const writes = findWrites(src);
    if (!writes.length) continue;
    const key = file.slice(API_SRC.length + 1);
    seen.add(key);
    const entry = WRITERS[key];
    if (!entry) {
      for (const w of writes) {
        violations.push(`${rel(file)}: unclassified ${w.op} on ${w.table} — route it through the Risk Governor and classify it in check-execution-single-entry.ts`);
      }
      continue;
    }
    counts[entry.role]++;
    if (entry.proof) {
      const proofPath = entry.proofFile ? join(API_SRC, entry.proofFile) : file;
      const proofSrc = existsSync(proofPath) ? stripComments(readFileSync(proofPath, "utf8")) : "";
      if (!entry.proof.test(proofSrc)) {
        violations.push(`${rel(file)}: ${entry.role} writer lost its proof ${entry.proof} in ${entry.proofFile ?? key}`);
      }
    }
    if (entry.role === "LIFECYCLE" || entry.role === "NON_TRADE") {
      for (const w of writes) {
        if (w.op !== "update") continue;
        const block = setBlockAfter(src, w.index);
        if (block == null) { violations.push(`${rel(file)}: ${entry.role} update on ${w.table} with a non-literal .set() — cannot prove it leaves exposure alone`); continue; }
        const bad = exposureKeysIn(block);
        if (bad.length) violations.push(`${rel(file)}: ${entry.role} update on ${w.table} sets exposure fields [${bad.join(", ")}]`);
      }
    }
  }

  for (const key of Object.keys(WRITERS)) {
    if (!seen.has(key)) violations.push(`stale classification: ${key} no longer writes an execution table — remove it from WRITERS`);
  }

  const oms = join(API_SRC, "lib/oms.ts");
  if (existsSync(oms)) {
    const src = stripComments(readFileSync(oms, "utf8"));
    for (const fn of OMS_RAW) {
      if (new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`).test(src) || new RegExp(`export\\s*\\{[^}]*\\b${fn}\\b`).test(src)) {
        violations.push(`artifacts/api-server/src/lib/oms.ts: raw OMS mutator ${fn} is exported — use the governed entry points`);
      }
    }
  }

  notes.push(`writers: ${counts.GOVERNED} governed, ${counts.LIFECYCLE} lifecycle, ${counts.NON_TRADE} non-trade, ${counts.QA_SCRIPT} QA scripts`);
  return { name: "execution-single-entry", ok: violations.length === 0, violations, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkExecutionSingleEntry();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
