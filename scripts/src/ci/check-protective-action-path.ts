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
//   1. livePositionManager.ts invokes runProtectiveActionPath( inside the
//      observation-hold branch (after the hold is counted, before its
//      `continue`), and the ordinary evaluatePositionObservation( call carries
//      no maxAgeMs of its own (the 90 s contract is untouched).
//   2. protectiveActionPath.ts never value-imports a position writer, a
//      command table, the live command pipeline, the Trade Engine, the MT5
//      transport, fetch or node:http; its only ruleId literal (if any) is
//      "self-trade-manage"; and within runProtectiveActionPath the evidence
//      evaluation precedes identity, identity precedes geometry, geometry
//      precedes the compare-and-set claim, and the claim precedes dispatch.
//   3. managementTarget.claimManagementCommand re-checks a protective claim
//      (pendingManagement?.protective → evaluateProtectiveObservation) after
//      assertManagementGeometry.
//   4. Only protectiveActionPath.ts constructs a `protective: {` block inside a
//      pendingManagement claim.
//   5. freshFacts.ts still exports POSITION_OBSERVATION_MAX_AGE_MS = 90_000 and
//      evaluateProtectiveObservation has no window literal of its own.
//   6. lib/domain/src/self-trade/protectiveAction.ts imports only from "./".
//   7. autonomousCycle.ts calls manageAgentPositions( only inside the
//      `!chain.shouldPauseManagement` block.
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
} as const;

export type Sources = Record<string, string>;

/** Module specifiers the path may never value-import (first match wins in the message). */
const FORBIDDEN_IMPORTS: Array<[RegExp, string]> = [
  [/\blivePositionWriter\b/, "livePositionWriter"],
  [/\bdemoPositionWriter\b/, "demoPositionWriter"],
  [/\bmt5CommandsTable\b/, "mt5CommandsTable"],
  [/^node:https?$/, "node:http"],
  [/mt5\/managementTargetTransport/, "../mt5/managementTargetTransport"],
  [/live\/liveCommandPipeline/, "../live/liveCommandPipeline"],
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

export function scanProtectiveSources(raw: Sources): string[] {
  const v: string[] = [];
  const get = (k: string) => (raw[k] == null ? null : stripComments(raw[k]!));

  // 1. Manager: invocation inside the hold branch; no private window.
  const manager = get(PROTECTIVE_FILES.manager);
  if (manager == null) v.push(`${PROTECTIVE_FILES.manager}: missing`);
  else {
    const counted = manager.indexOf("result.heldReasons[observation.reason]");
    const call = manager.indexOf("runProtectiveActionPath(");
    const next = counted < 0 ? -1 : manager.indexOf("continue;", counted);
    if (counted < 0) v.push(`${PROTECTIVE_FILES.manager}: the observation hold must still count result.heldReasons[observation.reason]`);
    else if (call < 0) v.push(`${PROTECTIVE_FILES.manager}: must invoke runProtectiveActionPath( from the observation hold`);
    else if (!(call > counted && next > call))
      v.push(`${PROTECTIVE_FILES.manager}: runProtectiveActionPath( must run after the hold is counted and before that branch's continue (not a bypass)`);
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
    for (const [re, label] of FORBIDDEN_IMPORTS.slice(0, 3))
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
      if (evidence < 0 || identity < 0 || geometry < 0 || claim < 0 || dispatch < 0)
        v.push(`${PROTECTIVE_FILES.path}: runProtectiveActionPath must evaluate evidence, verify identity, prove geometry, claim and dispatch`);
      else if (!(evidence < identity && identity < geometry && geometry < claim && claim < dispatch))
        v.push(`${PROTECTIVE_FILES.path}: order must be evidence → identity → geometry → compare-and-set claim → dispatch`);
    }
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
      if (!after.includes("doesNotLoosenStop(") || refusals < 2)
        v.push(`${PROTECTIVE_FILES.target}: the protective re-check must refuse on failed evidence and on a stop that no longer tightens (doesNotLoosenStop)`);
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
    }
  }
  return v;
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
