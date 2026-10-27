// CI guard — self-trade-kill-switch-coverage (emergency stops)
//
// Self-trade kill switches (self_trade_kill_switches: GLOBAL / NEWS / AGENT /
// STRATEGY / SYMBOL) refuse autonomous agent ENTRIES. They are checked at four
// points, and this guard fails if any of them is removed or reordered, or if a
// new surface starts reading/writing the switches or producing self-trade
// commands without review:
//
//   1. Pre-decision gate   executionGate.evaluateAgentExecution reads them and
//                          feeds killEngaged into evaluateExecutionPermission.
//   2. Executor TOCTOU     agentExecutor re-reads them AFTER reserveAgentEntry
//                          and BEFORE submitInstantTrade, inside try/catch so a
//                          read failure refuses (KILL_SWITCH_UNREADABLE).
//   3. Final claim         entryAuthority.withEntryAuthority (used by draft
//                          creation, the confirm claim and the final dispatch
//                          claim for agent entries) takes the shared kill lock,
//                          reads the switches through its transaction and
//                          refuses BEFORE running the claim operation.
//   4. Writes              only service.toggleKillSwitch writes the table, and
//                          it takes the exclusive kill lock in its transaction.
//
// Matching rules live in ONE place (killSwitchScope.evaluateKillSwitchRows);
// killSwitchGate delegates to it. Other readers of the table are allowlisted
// display/advisory surfaces that cannot dispatch.
//
// Platform-wide stops (emergency stop, safety-core kill switch) are covered by
// check-emergency-kill-switch and the emergencyKillSwitchPreGate unit test;
// the "every live order goes through dispatchLiveCommand" property is
// check-trade-engine-single-pipeline's job. This guard does not duplicate them.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");

export const FILES = {
  scope: "lib/selfTrade/killSwitchScope.ts",
  gate: "lib/selfTrade/killSwitchGate.ts",
  executionGate: "lib/selfTrade/executionGate.ts",
  executor: "lib/selfTrade/agentExecutor.ts",
  authority: "lib/selfTrade/entryAuthority.ts",
  cas: "lib/live/liveCommandCas.ts",
  pipeline: "lib/live/liveCommandPipeline.ts",
  service: "lib/selfTrade/service.ts",
} as const;

/** Runtime files allowed to reference selfTradeKillSwitchesTable, and why. */
export const TABLE_READERS: Record<string, string> = {
  [FILES.scope]: "the one matcher/reader used by every gate",
  [FILES.service]: "the only writer (toggleKillSwitch) and the admin list read",
  "lib/selfTrade/selfTradeOrchestrator.ts": "readiness display only; dispatches nothing",
  "lib/selfTrade/decisionEngine.ts": "pre-decision advisory GLOBAL read; the executor gate stays authoritative",
};
/** The only runtime file allowed to write the table. */
export const TABLE_WRITER = FILES.service;

/**
 * Runtime files that pass self-trade attribution (selfTradeAgentId) into a
 * Trade Engine producer, and which halt rule applies to them.
 *   ENTRY       — opens risk: must be kill-gated (points 1-3 above).
 *   MANAGEMENT  — MOVE_TO_BE / TIGHTEN_SL / EXIT on an existing position:
 *                 risk-reducing by construction, so self-trade switches do not
 *                 apply (docs/SELF_TRADING_EMERGENCY_STOPS_2026_10_27.md); the
 *                 platform emergency stop and Risk Governor halt still do.
 *   PASS_THROUGH — the one-click leg that forwards the caller's attribution.
 */
export const SELF_TRADE_PRODUCERS: Record<string, "ENTRY" | "MANAGEMENT" | "PASS_THROUGH"> = {
  [FILES.executor]: "ENTRY",
  "lib/selfTrade/livePositionManager.ts": "MANAGEMENT",
  "lib/live/instantTrade.ts": "PASS_THROUGH",
};
const PRODUCER_CALLS = /\b(submitInstantTrade|guardianInstantManage|submitTrade|draftTrade)\s*\(/;

/** Strip block and line comments so prose cannot satisfy a code assertion. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Extract `export (async )?function name(...) { ... }` (or a non-exported one) by bracket matching. */
export function functionBody(src: string, name: string): string | null {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(src);
  if (!m) return null;
  // Parameter list.
  let j = src.indexOf("(", m.index);
  if (j < 0) return null;
  for (let depth = 0; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) break;
  }
  // Return type (may contain {...} inside <...>): the body is the first "{" at angle depth 0.
  let angle = 0;
  for (j = j + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "<") angle++;
    else if (c === ">" && src[j - 1] !== "=") angle--;
    else if (c === "{" && angle === 0) break;
  }
  for (let k = j, depth = 0; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(j, k + 1);
  }
  return null;
}

function order(body: string, first: RegExp, second: RegExp): boolean {
  const a = body.search(first);
  const b = body.search(second);
  return a >= 0 && b >= 0 && a < b;
}

export type Sources = Record<string, string>;

/** Chokepoint assertions over the named files (pure: sources in, violations out). */
export function checkChokepoints(src: Sources): string[] {
  const v: string[] = [];
  const get = (k: string) => {
    const s = src[k];
    if (s == null) v.push(`${k}: missing — re-point check-self-trade-kill-switch-coverage`);
    return stripComments(s ?? "");
  };

  // Matcher: one copy of the rules, fail-closed on malformed rows.
  const scope = get(FILES.scope);
  if (!/export function evaluateKillSwitchRows\b/.test(scope)) v.push(`${FILES.scope}: evaluateKillSwitchRows missing`);
  if (!/"MALFORMED"/.test(scope) || !/default:\s*\n?\s*effective = "MALFORMED"/.test(scope))
    v.push(`${FILES.scope}: an engaged row with an unknown scope must fail closed (MALFORMED)`);
  if (!/\.trim\(\)\.toUpperCase\(\)/.test(scope)) v.push(`${FILES.scope}: refs must be compared trimmed and upper-cased`);
  if (!/eq\(selfTradeKillSwitchesTable\.engaged, true\)/.test(scope))
    v.push(`${FILES.scope}: reader must select engaged rows (engaged is the only truth)`);
  if (/catch\s*\(/.test(scope)) v.push(`${FILES.scope}: the reader must not catch read errors (callers refuse on throw)`);

  const gate = get(FILES.gate);
  if (!/return readKillSwitchVerdict\(input\)/.test(gate)) v.push(`${FILES.gate}: assertAgentNotKilled must delegate to readKillSwitchVerdict`);
  if (/case\s+"(AGENT|SYMBOL|STRATEGY|GLOBAL)"/.test(gate)) v.push(`${FILES.gate}: must not carry its own copy of the matching rules`);

  // 1. Pre-decision gate.
  const eg = get(FILES.executionGate);
  const egBody = functionBody(eg, "evaluateAgentExecution") ?? "";
  if (!/await assertAgentNotKilled\(/.test(egBody)) v.push(`${FILES.executionGate}: evaluateAgentExecution must read the kill switches`);
  if (!/killEngaged:\s*kill\.killed/.test(egBody)) v.push(`${FILES.executionGate}: killEngaged must come from the kill-switch read`);

  // 2. Executor TOCTOU: after reservation, before submission, fail closed.
  const ex = get(FILES.executor);
  const exBody = functionBody(ex, "executeAgentDecision") ?? "";
  if (!exBody) v.push(`${FILES.executor}: executeAgentDecision not found`);
  else {
    if (!order(exBody, /reserveAgentEntry\(/, /await assertAgentNotKilled\(/))
      v.push(`${FILES.executor}: the TOCTOU kill-switch read must follow reserveAgentEntry`);
    if (!order(exBody, /await assertAgentNotKilled\(/, /submitInstantTrade\(/))
      v.push(`${FILES.executor}: the TOCTOU kill-switch read must precede submitInstantTrade`);
    if (!/try\s*\{\s*killNow = await assertAgentNotKilled\(/.test(exBody) || !/KILL_SWITCH_UNREADABLE/.test(exBody))
      v.push(`${FILES.executor}: a TOCTOU read failure must be caught and refused (KILL_SWITCH_UNREADABLE)`);
    if (!/if \(killNow\.killed\)\s*\{[\s\S]{0,1600}?return \{ status: "BLOCKED"/.test(exBody))
      v.push(`${FILES.executor}: an engaged TOCTOU verdict must return BLOCKED before submission`);
  }

  // 3. Final claim under the entry-authority locks.
  const au = get(FILES.authority);
  const auBody = functionBody(au, "withEntryAuthority") ?? "";
  if (!auBody) v.push(`${FILES.authority}: withEntryAuthority not found`);
  else {
    if (!order(auBody, /await lockKillSwitchesShared\(tx\)/, /readKillSwitchVerdict\(/))
      v.push(`${FILES.authority}: the shared kill lock must be taken before the kill-switch read`);
    if (!/readKillSwitchVerdict\([\s\S]{0,400}?,\s*tx,?\s*\)/.test(auBody))
      v.push(`${FILES.authority}: the kill-switch read must run on the authority transaction`);
    if (!order(auBody, /if \(kill\.killed\) return refuse\(ENTRY_KILL_SWITCH_ENGAGED\)/, /return operation\(/))
      v.push(`${FILES.authority}: an engaged switch must refuse before the claim operation runs`);
    if (/readKillSwitchVerdict\([\s\S]{0,400}?\)\s*\.catch\(/.test(auBody) || /try\s*\{[\s\S]{0,200}readKillSwitchVerdict/.test(auBody))
      v.push(`${FILES.authority}: a kill-switch read failure must propagate (roll back, refuse), never be swallowed`);
  }
  const draftBody = functionBody(au, "createAgentEntryDraft") ?? "";
  if (!/return withEntryAuthority\(/.test(draftBody)) v.push(`${FILES.authority}: createAgentEntryDraft must run under withEntryAuthority`);

  const cas = get(FILES.cas);
  for (const fn of ["claimLiveCommandForDispatch", "claimLiveCommandForConfirm"]) {
    const body = functionBody(cas, fn) ?? "";
    if (!/if \(observed && isAgentEntryCommand\(observed\)\)\s*return claimAgentCommand\(/.test(body))
      v.push(`${FILES.cas}: ${fn} must route agent ENTRY commands through claimAgentCommand`);
  }
  if (!/async function claimAgentCommand[\s\S]{0,400}?return withEntryAuthority\(/.test(cas))
    v.push(`${FILES.cas}: claimAgentCommand must run under withEntryAuthority`);

  const pipe = get(FILES.pipeline);
  if (!/agentOrigin \? await createAgentEntryDraft\(/.test(pipe))
    v.push(`${FILES.pipeline}: agent-origin drafts must be created through createAgentEntryDraft`);
  const dispatchBody = functionBody(pipe, "dispatchLiveCommand") ?? "";
  if (!/await claimLiveCommandForDispatch\(/.test(dispatchBody))
    v.push(`${FILES.pipeline}: dispatchLiveCommand must claim through claimLiveCommandForDispatch`);

  // 4. Writes serialize against claims.
  const svc = get(FILES.service);
  const toggle = functionBody(svc, "toggleKillSwitch") ?? "";
  if (!/db\.transaction\(async \(tx\) => \{\s*await lockKillSwitchesExclusive\(tx\);/.test(toggle))
    v.push(`${FILES.service}: toggleKillSwitch must take the exclusive kill lock first in its transaction`);
  return v;
}

/** Tree scan: table readers/writers and self-trade producers are allowlisted. */
export function scanRuntimeFile(key: string, raw: string): string[] {
  const v: string[] = [];
  const src = stripComments(raw);
  if (/\bselfTradeKillSwitchesTable\b/.test(src) && !(key in TABLE_READERS))
    v.push(`${key}: references selfTradeKillSwitchesTable — use killSwitchScope.readKillSwitchVerdict, or allowlist with a reason`);
  if (/\.(insert|update|delete)\(\s*selfTradeKillSwitchesTable\b/.test(src) && key !== TABLE_WRITER)
    v.push(`${key}: writes self_trade_kill_switches outside ${TABLE_WRITER}`);
  if (/self_trade_kill_switches/.test(src) && key !== FILES.scope)
    v.push(`${key}: raw SQL on self_trade_kill_switches bypasses the matcher`);
  if (/\bselfTradeAgentId\b/.test(src) && PRODUCER_CALLS.test(src) && !(key in SELF_TRADE_PRODUCERS))
    v.push(`${key}: new self-trade producer (selfTradeAgentId + Trade Engine call) — classify it in SELF_TRADE_PRODUCERS and prove its kill-switch coverage`);
  return v;
}

function isRuntime(key: string): boolean {
  return !key.includes("__qa__") && !key.endsWith(".test.ts") && !key.startsWith("scripts/");
}

export function checkSelfTradeKillSwitchCoverage(): CheckResult {
  const violations: string[] = [];
  const src: Sources = {};
  for (const k of Object.values(FILES)) {
    const p = join(API_SRC, k);
    if (existsSync(p)) src[k] = readFileSync(p, "utf8");
  }
  violations.push(...checkChokepoints(src));
  let scanned = 0;
  for (const p of walk(API_SRC)) {
    const key = rel(p).replace(/^artifacts\/api-server\/src\//, "");
    if (!isRuntime(key)) continue;
    scanned++;
    violations.push(...scanRuntimeFile(key, readFileSync(p, "utf8")));
  }
  for (const k of [...Object.keys(TABLE_READERS), ...Object.keys(SELF_TRADE_PRODUCERS)]) {
    if (!existsSync(join(API_SRC, k))) violations.push(`stale allowlist entry: ${k} no longer exists`);
  }
  return {
    name: "self-trade-kill-switch-coverage",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} runtime files scanned; ${Object.keys(FILES).length} chokepoint files asserted`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSelfTradeKillSwitchCoverage();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
