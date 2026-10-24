// Position Guardian — no fill, snapshot or reconnect escapes it
// (Tier 1 finalization, items 3 and 4).
//
// Every broker fact that can change a governed position's protection must
// reach lib/positionGuardian/reconcile.ts, and the Guardian may correct a
// stop only through the venue's own governed queue. This guard fails when:
//   1. a file records a broker command result (recordLiveCommandResult /
//      reconcileBrokerResult) without scheduling the Guardian,
//   2. a required hook is missing: the live and demo fill handlers, the live
//      position snapshot, the trader's own (demo) position snapshot, and the
//      bridge heartbeat's reconnect marker,
//   3. lib/positionGuardian/ writes any table other than through
//      logRiskEvent (no direct order, command or position writes), or submits
//      a correction other than through lib/positions/governedOps.ts
//      (submitGovernedModify → createLiveOpsDraft / createDraftCommand).
// QA fixtures (__qa__, *.test.ts) and src/scripts are exempt.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const GUARDIAN_DIR = "lib/positionGuardian/";
const RESULT_RECORDERS = /\b(recordLiveCommandResult|reconcileBrokerResult)\s*\(/;
const DEFINERS = new Set(["lib/live/liveCommandPipeline.ts", "lib/mt5/demoCommandReconciler.ts"]);

/** [file, pattern, what] — hooks that must exist. */
export const REQUIRED_HOOKS: Array<[string, RegExp, string]> = [
  ["routes/mt5Live.ts", /scheduleGuardian\(\s*"LIVE"[^;]*"fill"\s*\)/, "live fill handler schedules the Guardian"],
  ["routes/mt5Live.ts", /scheduleGuardian\(\s*"LIVE"[^;]*"snapshot"\s*\)/, "live position snapshot schedules the Guardian"],
  ["routes/mt5DemoBridge.ts", /scheduleGuardian\(\s*"DEMO"[^;]*"fill"\s*\)/, "demo fill handler schedules the Guardian"],
  ["routes/mt5.ts", /scheduleGuardian\(\s*"DEMO"[^;]*"snapshot"\s*\)/, "the trader's own position snapshot schedules the Guardian"],
  ["routes/mt5.ts", /noteBridgeHeartbeat\(/, "the bridge heartbeat marks reconnects"],
];

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

/** Violations for a file that records broker results. */
export function scanResultRecorder(src: string): string[] {
  const code = stripComments(src);
  return RESULT_RECORDERS.test(code) && !/\bscheduleGuardian\s*\(/.test(code)
    ? ["records a broker command result without scheduling the Position Guardian"] : [];
}

/** Violations inside the Guardian itself. */
export function scanGuardianSource(src: string): string[] {
  const out: string[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    if (/\b(db|tx)\s*\.\s*(insert|update|delete)\s*\(/.test(line) || /\bsql`\s*(insert|update|delete)\b/i.test(line)) out.push(`${i + 1}: the Guardian writes a table directly; it may only audit via logRiskEvent`);
    if (/\b(queueMt5CommandWithGate|enqueueBridgedMt5Command|mt5CommandsTable)\b/.test(line)) out.push(`${i + 1}: the Guardian reaches a broker queue outside the governed draft/confirm/dispatch path`);
  });
  return out;
}

export function checkPositionGuardianWired(): CheckResult {
  const violations: string[] = [];
  for (const [file, re, what] of REQUIRED_HOOKS) {
    const p = join(API_SRC, file);
    if (!existsSync(p) || !re.test(stripComments(readFileSync(p, "utf8")))) violations.push(`artifacts/api-server/src/${file}: missing hook: ${what}`);
  }
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    if (key.startsWith(GUARDIAN_DIR)) {
      for (const v of scanGuardianSource(src)) violations.push(`${rel(file)}:${v}`);
    } else if (!DEFINERS.has(key)) {
      for (const v of scanResultRecorder(src)) violations.push(`${rel(file)}: ${v}`);
    }
  }
  const reconcile = join(API_SRC, GUARDIAN_DIR, "reconcile.ts");
  if (existsSync(reconcile)) {
    if (!/submitGovernedModify\(/.test(stripComments(readFileSync(reconcile, "utf8")))) {
      violations.push("lib/positionGuardian/reconcile.ts: corrections must go through submitGovernedModify (lib/positions/governedOps.ts)");
    }
  } else violations.push("lib/positionGuardian/reconcile.ts missing");
  const ops = join(API_SRC, "lib/positions/governedOps.ts");
  if (existsSync(ops)) {
    const src = stripComments(readFileSync(ops, "utf8"));
    if (!/createLiveOpsDraft\(/.test(src) || !/createDraftCommand\(/.test(src)) {
      violations.push("lib/positions/governedOps.ts: governed ops must go through createLiveOpsDraft / createDraftCommand");
    }
  } else violations.push("lib/positions/governedOps.ts missing");
  return {
    name: "position-guardian-wired",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; ${REQUIRED_HOOKS.length} required Guardian hooks`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkPositionGuardianWired();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
