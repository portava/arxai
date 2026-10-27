// Self-Trade AI — protective-action path stays a stricter path, never a bypass
// (owner decision 2026-10-27; docs/SELF_TRADING_PROTECTIVE_PATH_2026_10_27.md).
//
// The ordinary manager holds on a stale broker snapshot. The protective path
// starts FROM that hold and may act only on a strictly newer complete sweep
// that passes a stricter evidence standard, after identity and geometry are
// re-proven, through the same claim and the same Guardian → executeInstant
// pipeline. This guard pins the source order and import discipline that keep
// it that way:
//
//   1. livePositionManager.ts queues the candidate (queueProtectiveCandidate()
//      inside the bracket-matched `if (!observation.ok) {` block, after the
//      hold is counted, and that block ends with `continue;`), never calls
//      runProtectiveActionPath( itself, drains its own cycle only after the
//      per-execution loop, and the ordinary evaluatePositionObservation( call
//      carries no maxAgeMs of its own (the 90 s contract is untouched).
//   2. protectiveActionPath.ts never imports (statically or with import())
//      a position writer, a command table, the live command pipeline,
//      instantTrade, the Trade Engine, the MT5 transport, fetch or node:http;
//      its only ruleId literal (if any) is "self-trade-manage"; within
//      runProtectiveActionPath the order is evidence → identity → final
//      bridge identity → geometry → compare-and-set claim → dispatch, and each
//      of those checks refuses in the exact shape `if (!X.ok) return hold(`
//      (evidence after its wait loop, every verifyProtectiveBridge( call,
//      identity, geometry); drainProtectiveCycle calls runProtectiveActionPath(.
//   3. managementTarget.claimManagementCommand re-checks a protective claim
//      (pendingManagement?.protective → evaluateProtectiveObservation, then
//      evaluateTicketCommands over the ticket's other commands) after
//      assertManagementGeometry.
//   4. Only protectiveActionPath.ts constructs a `protective: {` block inside a
//      pendingManagement claim.
//   5. freshFacts.ts still exports POSITION_OBSERVATION_MAX_AGE_MS = 90_000 and
//      evaluateProtectiveObservation has no window literal of its own.
//   6. lib/domain/src/self-trade/protectiveAction.ts imports only from "./".
//   7. autonomousCycle.ts calls manageAgentPositions( only inside the
//      `!chain.shouldPauseManagement` block, with the cycle's protectiveCycle,
//      and drains that cycle (drainProtectiveCycle() only after the per-agent
//      loop.
//
// Pure source analysis (comment-stripped text): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";
import { functionBody, stripComments } from "./check-self-trade-kill-switch-coverage.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");

/** Repo-relative paths of the files this guard asserts. */
export const PROTECTIVE_FILES = {
  manager: "artifacts/api-server/src/lib/selfTrade/livePositionManager.ts",
  path: "artifacts/api-server/src/lib/selfTrade/protectiveActionPath.ts",
  target: "artifacts/api-server/src/lib/selfTrade/managementTarget.ts",
  freshFacts: "artifacts/api-server/src/lib/selfTrade/freshFacts.ts",
  domain: "lib/domain/src/self-trade/protectiveAction.ts",
  cycle: "artifacts/api-server/src/lib/selfTrade/autonomousCycle.ts",
  rules: "artifacts/api-server/src/lib/positionGuardian/rules.ts",
  killSwitch: "scripts/src/ci/check-self-trade-kill-switch-coverage.ts",
} as const;

/** The api-server-relative module id both registries must carry. */
const PATH_MODULE_ID = "lib/selfTrade/protectiveActionPath.ts";

export type Sources = Record<string, string>;

/** Identifiers the path may never reference (a writer or a command table). */
const FORBIDDEN_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\blivePositionWriter\b/, "livePositionWriter"],
  [/\bdemoPositionWriter\b/, "demoPositionWriter"],
  [/\bmt5CommandsTable\b/, "mt5CommandsTable"],
  [/\barxLiveCommandsTable\b/, "arxLiveCommandsTable"],
];
/** Module specifiers the path may never import, statically or with import() (first match wins in the message). */
const FORBIDDEN_IMPORTS: Array<[RegExp, string]> = [
  ...FORBIDDEN_IDENTIFIERS,
  [/^node:https?$/, "node:http"],
  [/mt5\/managementTargetTransport/, "../mt5/managementTargetTransport"],
  [/live\/liveCommandPipeline/, "../live/liveCommandPipeline"],
  [/live\/instantTrade/, "../live/instantTrade"],
  [/(?:^|\/)tradeEngine\//, "tradeEngine/"],
];

/** `{ ... }` block starting at the first "{" at or after `from`, bracket-matched. */
function blockAfter(src: string, from: number): string | null {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** The parenthesised argument text of the first `name(` call at or after `from`. */
function callArgs(src: string, name: string, from = 0): string | null {
  const at = src.indexOf(`${name}(`, from);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at + name.length, i + 1);
  }
  return null;
}

/** Every import declaration's specifier and whether it is type-only. */
function imports(src: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const re = /import\s+(type\s+)?[^;]*?\sfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ spec: m[2]!, typeOnly: !!m[1] });
  const side = /import\s*["']([^"']+)["']/g;
  while ((m = side.exec(src))) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** Every dynamic import( call: its literal specifier, or null when computed. */
function dynamicImports(src: string): Array<string | null> {
  const out: Array<string | null> = [];
  const re = /(?<![\w$.])import\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const lit = /^(["'`])([^"'`$]+)\1\s*[,)]/.exec(rest);
    out.push(lit ? lit[2]! : null);
  }
  return out;
}

/** Index just past the `)` that closes the `name(` call starting at `at`, or -1. */
function callEnd(src: string, at: number, name: string): number {
  let depth = 0;
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every `const X = name(` (or `X = name(` when `assigned`) in `body`, with
 * whether the statement right after the call is the exact refusal
 * `if (!X.ok) <then>` (or, when `anywhereAfter`, whether that refusal
 * appears anywhere after the call).
 */
function refusalShapes(
  body: string,
  name: string,
  then: string,
  opts: { assigned?: boolean; anywhereAfter?: boolean } = {},
): Array<{ at: number; variable: string; refuses: boolean }> {
  const decl = opts.assigned
    ? new RegExp(`(?:const\\s+|let\\s+)?(\\w+)\\s*=\\s*${name}\\(`, "g")
    : new RegExp(`const\\s+(\\w+)\\s*=\\s*${name}\\(`, "g");
  const out: Array<{ at: number; variable: string; refuses: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(body))) {
    const variable = m[1]!;
    const callAt = m.index + m[0].length - name.length - 1;
    const end = callEnd(body, callAt, name);
    const refusal = new RegExp(`${opts.anywhereAfter ? "" : "^\\s*;?\\s*"}if\\s*\\(\\s*!\\s*${escapeRe(variable)}\\.ok\\s*\\)\\s*${then}`);
    out.push({ at: m.index, variable, refuses: end > 0 && refusal.test(body.slice(end)) });
  }
  return out;
}

export function scanProtectiveSources(raw: Sources): string[] {
  const v: string[] = [];
  const get = (k: string) => (raw[k] == null ? null : stripComments(raw[k]!));

  // 1. Manager: the candidate is queued inside the hold branch, which still
  //    counts the hold and ends with continue; it runs only after the loop.
  const manager = get(PROTECTIVE_FILES.manager);
  if (manager == null) v.push(`${PROTECTIVE_FILES.manager}: missing`);
  else {
    const gate = manager.indexOf("if (!observation.ok) {");
    const block = gate < 0 ? null : blockAfter(manager, gate);
    if (block == null) v.push(`${PROTECTIVE_FILES.manager}: the observation hold block (if (!observation.ok) {) is missing`);
    else {
      const counted = block.indexOf("result.heldReasons[observation.reason]");
      const queued = block.indexOf("queueProtectiveCandidate(");
      if (counted < 0) v.push(`${PROTECTIVE_FILES.manager}: the observation hold must still count result.heldReasons[observation.reason]`);
      else if (queued < 0) v.push(`${PROTECTIVE_FILES.manager}: must queue the protective candidate (queueProtectiveCandidate() from the observation hold`);
      else if (!(queued > counted))
        v.push(`${PROTECTIVE_FILES.manager}: queueProtectiveCandidate( must run after the hold is counted (not a bypass)`);
      if (!/continue;\s*\}$/.test(block))
        v.push(`${PROTECTIVE_FILES.manager}: the observation hold block must end with continue; (the refused observation never reaches the ordinary decision)`);
      const loopAt = manager.indexOf("for (const e of filled) {");
      const loop = loopAt < 0 ? null : blockAfter(manager, loopAt);
      const loopEnd = loop == null ? -1 : manager.indexOf(loop, loopAt) + loop.length;
      const drain = manager.indexOf("drainProtectiveCycle(");
      if (loop == null) v.push(`${PROTECTIVE_FILES.manager}: the per-execution loop (for (const e of filled) {) is missing`);
      else if (drain < 0 || drain < loopEnd)
        v.push(`${PROTECTIVE_FILES.manager}: a standalone call must drainProtectiveCycle( after the per-execution loop (ordinary dispatches first)`);
    }
    if (/\brunProtectiveActionPath\(/.test(manager))
      v.push(`${PROTECTIVE_FILES.manager}: must not call runProtectiveActionPath( inline; queue the candidate and drain after the ordinary loop`);
    const ordinary = callArgs(manager, "evaluatePositionObservation");
    if (ordinary == null) v.push(`${PROTECTIVE_FILES.manager}: the ordinary evaluatePositionObservation( call is missing`);
    else if (/\bmaxAgeMs\b/.test(ordinary))
      v.push(`${PROTECTIVE_FILES.manager}: the ordinary evaluatePositionObservation( call must not carry its own maxAgeMs`);
  }

  // 2. Path: import discipline, rule id, source order.
  const path = get(PROTECTIVE_FILES.path);
  if (path == null) v.push(`${PROTECTIVE_FILES.path}: missing`);
  else {
    for (const imp of imports(path)) {
      if (imp.typeOnly) continue;
      for (const [re, label] of FORBIDDEN_IMPORTS)
        if (re.test(imp.spec)) v.push(`${PROTECTIVE_FILES.path}: value-imports "${imp.spec}" (${label}); the path never writes positions or commands and never reaches a broker itself`);
    }
    for (const spec of dynamicImports(path)) {
      if (spec == null) v.push(`${PROTECTIVE_FILES.path}: dynamic import( of a computed specifier; every dependency must be a static, checkable import`);
      else
        for (const [re, label] of FORBIDDEN_IMPORTS)
          if (re.test(spec)) v.push(`${PROTECTIVE_FILES.path}: dynamically imports "${spec}" (${label}); the path never writes positions or commands and never reaches a broker itself`);
    }
    for (const [re, label] of FORBIDDEN_IDENTIFIERS)
      if (re.test(path)) v.push(`${PROTECTIVE_FILES.path}: references ${label}`);
    if (/\bfetch\s*\(/.test(path)) v.push(`${PROTECTIVE_FILES.path}: calls fetch(`);
    const ruleIds = [...path.matchAll(/\bruleId\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const id of ruleIds)
      if (id !== "self-trade-manage") v.push(`${PROTECTIVE_FILES.path}: acts under rule "${id}"; only "self-trade-manage" is registered for it`);
    const body = functionBody(path, "runProtectiveActionPath");
    if (body == null) v.push(`${PROTECTIVE_FILES.path}: runProtectiveActionPath is missing`);
    else {
      const evidence = body.indexOf("evaluateProtectiveObservation(");
      const identity = body.indexOf("verifyProtectivePosition(");
      const geometry = body.indexOf("evaluateProtectiveGeometry(");
      const claim = body.indexOf("updateManagement(");
      const dispatch = body.search(/\bdispatch\(|\bdispatchClaimedManagement\(/);
      const bridges = refusalShapes(body, "verifyProtectiveBridge", "return\\s+hold\\(");
      const finalBridge = bridges.length ? bridges[bridges.length - 1]!.at : -1;
      if (evidence < 0 || identity < 0 || geometry < 0 || claim < 0 || dispatch < 0)
        v.push(`${PROTECTIVE_FILES.path}: runProtectiveActionPath must evaluate evidence, verify identity, prove geometry, claim and dispatch`);
      else if (!(evidence < identity && identity < geometry && geometry < claim && claim < dispatch))
        v.push(`${PROTECTIVE_FILES.path}: order must be evidence → identity → geometry → compare-and-set claim → dispatch`);
      else if (bridges.length < 2 || !(finalBridge > evidence && finalBridge < geometry))
        v.push(`${PROTECTIVE_FILES.path}: bridge identity must be verified before the wait and again on the final connection record (after evidence, before geometry and the claim)`);
      // Each refusal in its exact shape: a removed or weakened `if (!X.ok)
      // return hold(` (e.g. `|| true`, deleted line) is a violation.
      const shapes: Array<[string, ReturnType<typeof refusalShapes>]> = [
        ["evidence (evaluateProtectiveObservation)", refusalShapes(body, "evaluateProtectiveObservation", "return\\s+hold\\(", { assigned: true, anywhereAfter: true })],
        ["identity (verifyProtectivePosition)", refusalShapes(body, "verifyProtectivePosition", "return\\s+hold\\(")],
        ["geometry (evaluateProtectiveGeometry)", refusalShapes(body, "evaluateProtectiveGeometry", "return\\s+hold\\(")],
        ["bridge (verifyProtectiveBridge)", bridges],
      ];
      for (const [label, found] of shapes) {
        if (found.length === 0) v.push(`${PROTECTIVE_FILES.path}: ${label} must be bound to a variable and refused with if (!X.ok) return hold(`);
        for (const f of found)
          if (!f.refuses) v.push(`${PROTECTIVE_FILES.path}: ${label} result "${f.variable}" must be refused with if (!${f.variable}.ok) return hold(`);
      }
    }
    const drain = functionBody(path, "drainProtectiveCycle");
    if (drain == null || !drain.includes("runProtectiveActionPath("))
      v.push(`${PROTECTIVE_FILES.path}: drainProtectiveCycle must run each queued candidate through runProtectiveActionPath(`);
  }

  // 3. Final-claim parity.
  const target = get(PROTECTIVE_FILES.target);
  if (target == null) v.push(`${PROTECTIVE_FILES.target}: missing`);
  else {
    const body = functionBody(target, "claimManagementCommand") ?? "";
    const geometry = body.indexOf("assertManagementGeometry(");
    const protective = body.indexOf("pendingManagement?.protective");
    const evidence = body.indexOf("evaluateProtectiveObservation(");
    if (geometry < 0) v.push(`${PROTECTIVE_FILES.target}: claimManagementCommand must still call assertManagementGeometry(`);
    if (protective < 0 || evidence < 0)
      v.push(`${PROTECTIVE_FILES.target}: claimManagementCommand must re-check a protective claim (pendingManagement?.protective → evaluateProtectiveObservation()`);
    else if (!(protective > geometry && evidence > geometry))
      v.push(`${PROTECTIVE_FILES.target}: the protective re-check must follow assertManagementGeometry(`);
    else {
      const after = body.slice(protective);
      const refusals = after.match(/\brefuse\(/g)?.length ?? 0;
      if (!after.includes("doesNotLoosenStop(") || refusals < 3)
        v.push(`${PROTECTIVE_FILES.target}: the protective re-check must refuse on failed evidence and on a stop that no longer tightens (doesNotLoosenStop)`);
      const tickets = refusalShapes(after, "evaluateTicketCommands", "refuse\\(");
      if (tickets.length === 0 || tickets.some((t) => !t.refuses))
        v.push(`${PROTECTIVE_FILES.target}: the protective re-check must refuse a ticket command in flight or after the evidence (const X = evaluateTicketCommands(...); if (!X.ok) refuse(...))`);
    }
  }

  // 4. One constructor of protective claims.
  for (const [key, text] of Object.entries(raw)) {
    if (key === PROTECTIVE_FILES.path || !key.startsWith("artifacts/api-server/src/")) continue;
    if (key.includes("/__qa__/") || key.endsWith(".test.ts") || key.includes("/src/scripts/")) continue;
    if (/pendingManagement[\s\S]{0,600}?\bprotective\s*:\s*\{/.test(stripComments(text)))
      v.push(`${key}: constructs a protective claim; only ${PROTECTIVE_FILES.path} may`);
  }

  // 5. No private freshness window.
  const fresh = get(PROTECTIVE_FILES.freshFacts);
  if (fresh == null) v.push(`${PROTECTIVE_FILES.freshFacts}: missing`);
  else {
    if (!/export\s+const\s+POSITION_OBSERVATION_MAX_AGE_MS\s*=\s*90_000\b/.test(fresh))
      v.push(`${PROTECTIVE_FILES.freshFacts}: POSITION_OBSERVATION_MAX_AGE_MS must stay the existing 90_000 contract`);
    const body = functionBody(fresh, "evaluateProtectiveObservation");
    if (body == null) v.push(`${PROTECTIVE_FILES.freshFacts}: evaluateProtectiveObservation is missing`);
    else if (/\b\d{1,3}(?:_\d{3})+\b|\b\d{4,}\b/.test(body))
      v.push(`${PROTECTIVE_FILES.freshFacts}: evaluateProtectiveObservation carries a literal window; use POSITION_OBSERVATION_MAX_AGE_MS and the heartbeat policy`);
  }

  // 6. Domain purity.
  const domain = get(PROTECTIVE_FILES.domain);
  if (domain == null) v.push(`${PROTECTIVE_FILES.domain}: missing`);
  else
    for (const imp of imports(domain))
      if (!imp.spec.startsWith("./")) v.push(`${PROTECTIVE_FILES.domain}: imports "${imp.spec}"; the pure module imports only from "./"`);

  // 7. Management (and the protective path with it) never runs under an AACI pause.
  const cycle = get(PROTECTIVE_FILES.cycle);
  if (cycle == null) v.push(`${PROTECTIVE_FILES.cycle}: missing`);
  else {
    const gate = cycle.indexOf("if (!chain.shouldPauseManagement)");
    const block = gate < 0 ? null : blockAfter(cycle, gate);
    if (!block) v.push(`${PROTECTIVE_FILES.cycle}: the !chain.shouldPauseManagement block is missing`);
    else {
      const start = cycle.indexOf(block, gate);
      const end = start + block.length;
      const re = /\bmanageAgentPositions\(/g;
      let m: RegExpExecArray | null;
      let calls = 0;
      while ((m = re.exec(cycle))) {
        calls++;
        if (m.index < start || m.index > end)
          v.push(`${PROTECTIVE_FILES.cycle}: manageAgentPositions( is called outside the !chain.shouldPauseManagement block`);
      }
      if (calls === 0) v.push(`${PROTECTIVE_FILES.cycle}: manageAgentPositions( is never called`);
      const args = callArgs(cycle, "manageAgentPositions") ?? "";
      if (!/\bprotectiveCycle\b/.test(args))
        v.push(`${PROTECTIVE_FILES.cycle}: manageAgentPositions( must receive the cycle's protectiveCycle (protective waits run after every agent's ordinary dispatches)`);
      const loopAt = cycle.indexOf("for (const agentId of agentIds) {");
      const loop = loopAt < 0 ? null : blockAfter(cycle, loopAt);
      const loopEnd = loop == null ? -1 : cycle.indexOf(loop, loopAt) + loop.length;
      const drains = [...cycle.matchAll(/\bdrainProtectiveCycle\(/g)].map((m) => m.index!);
      if (loop == null) v.push(`${PROTECTIVE_FILES.cycle}: the per-agent loop (for (const agentId of agentIds) {) is missing`);
      else if (drains.length !== 1 || drains[0]! < loopEnd)
        v.push(`${PROTECTIVE_FILES.cycle}: drainProtectiveCycle( must run exactly once, after the per-agent loop`);
    }
  }

  // 8. Registration parity: the path is a module of the "self-trade-manage"
  //    Guardian rule and a classified MANAGEMENT producer in the kill-switch
  //    guard. Without this, dropping either registration would pass ci:guards,
  //    because the path itself carries no ruleId literal and no producer call.
  const rules = get(PROTECTIVE_FILES.rules);
  if (rules == null) v.push(`${PROTECTIVE_FILES.rules}: missing`);
  else {
    const id = rules.indexOf('id: "self-trade-manage"');
    const next = id < 0 ? -1 : rules.indexOf("\n  {", id);
    const block = id < 0 ? "" : rules.slice(id, next < 0 ? undefined : next);
    const modules = callArgsLike(block, "modules");
    if (id < 0) v.push(`${PROTECTIVE_FILES.rules}: the "self-trade-manage" rule is missing`);
    else if (modules == null || !modules.includes(`"${PATH_MODULE_ID}"`))
      v.push(`${PROTECTIVE_FILES.rules}: "self-trade-manage".modules must list "${PATH_MODULE_ID}" (the path acts under that rule)`);
  }
  const ks = get(PROTECTIVE_FILES.killSwitch);
  if (ks == null) v.push(`${PROTECTIVE_FILES.killSwitch}: missing`);
  else {
    const decl = ks.indexOf("export const SELF_TRADE_PRODUCERS");
    const body = decl < 0 ? null : blockAfter(ks, decl);
    const entry = new RegExp(`"${PATH_MODULE_ID.replace(/[./]/g, "\\$&")}"\\s*:\\s*"MANAGEMENT"`);
    if (decl < 0 || body == null) v.push(`${PROTECTIVE_FILES.killSwitch}: SELF_TRADE_PRODUCERS is missing`);
    else if (!entry.test(body))
      v.push(`${PROTECTIVE_FILES.killSwitch}: SELF_TRADE_PRODUCERS must classify "${PATH_MODULE_ID}" as "MANAGEMENT"`);
  }
  return v;
}

/** Text of the `[...]` array assigned to `name:` inside `src`, or null. */
function callArgsLike(src: string, name: string): string | null {
  const at = src.indexOf(`${name}:`);
  if (at < 0) return null;
  const open = src.indexOf("[", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

export function checkProtectiveActionPath(): CheckResult {
  const src: Sources = {};
  for (const key of Object.values(PROTECTIVE_FILES)) {
    const p = join(ROOT, key);
    if (existsSync(p)) src[key] = readFileSync(p, "utf8");
  }
  let scanned = 0;
  for (const p of walk(API_SRC, { skip: (x) => x.includes("/__qa__/") || x.endsWith(".test.ts") || x.includes("/src/scripts/") })) {
    const key = rel(p);
    scanned++;
    if (!(key in src)) src[key] = readFileSync(p, "utf8");
  }
  const violations = scanProtectiveSources(src);
  return {
    name: "protective-action-path",
    ok: violations.length === 0,
    violations,
    notes: [`${Object.keys(PROTECTIVE_FILES).length} files asserted; ${scanned} runtime files scanned for protective-claim constructors`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkProtectiveActionPath();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
