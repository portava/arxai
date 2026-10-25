// One source for the platform's safety switches (Tier 1 Platform Safety).
//
// The switches that can say "trading is stopped" or "this venue is open" are
// read through one authority, lib/safety/ (platformSwitches.ts for the
// install-wide switches, tradingHalt.ts for the per-trader halt and the
// venue verdict). A file that reads a switch column itself can disagree with
// what the order path enforces (different row, different default, different
// fail-open/fail-closed rule), so this guard fails on, outside the authority:
//
//   1. a global_trading_settings switch column (platform mode, venue enables,
//      emergency stop, operator live arm) referenced through
//      globalTradingSettingsTable.<column>;
//   2. a whole-row read of global_trading_settings (select().from(table)),
//      which carries every switch;
//   3. a write to global_trading_settings outside the reviewed writers;
//   4. any reference to safetyCoreTable outside its owner (lib/safetyCore.ts);
//   5. any reference to arxLiveArmingTable (the trader's arming row and kill
//      switch) outside its owner (lib/live/liveArming.ts);
//   6. loadGlobalTradingSettingsRow() (the raw row, switches included)
//      outside the reviewed writers;
//   7. a direct read of the env master switch helper
//      (isLiveBrokerExecutionEnabledEnv) outside its reviewed readers;
//   8. raw SQL naming a switch column or the safety_core table;
//   9. one install-wide stop's raw value read on its own — the emergency
//      stop (`.emergencyStop` of the switches, `.emergencyKillSwitch` of a
//      derived view such as the envelope), the safety-core kill switch
//      (readSafetyCoreSwitch(), or `.killSwitchEngaged` in a file that gets
//      lib/safetyCore.ts getStatus()). A pre-check reads both through
//      platformStop() + preCheckStopRefusal() instead; the reviewed readers
//      left (Ruby's copy of the envelope field, the pure dispatch pre-gate, the
//      audited writers and legacy gates the Risk Governor does not run behind)
//      are listed below with a reason. A report or readiness view that says
//      "is trading stopped" reads platformStop() too (platformStopWith() when
//      it already read the switches);
//  10. an ENGAGED emergency stop written anywhere but the one engage writer,
//      lib/safety/platformStopWriter.ts (engagePlatformStop(), which writes
//      every settings row): an `emergencyKillSwitch: <not false>` property in
//      a .set() / .values() object, or `<x>.emergencyKillSwitch = <not false>`;
//      and a call to engagePlatformStop() from a file that does not write
//      admin_action_audit_log (every engage stays audited). (Round 5, owner
//      decision 1) the same for RELEASES: an `emergencyKillSwitch: false`
//      property in a .set() / .values() object, `<x>.emergencyKillSwitch =
//      false`, or a call to the safety core's resetKillSwitch() outside the one
//      release operation (releasePlatformStop() in the same writer, which is
//      authorized and audited itself). Live activation may not release a stop.
//  11. (Round 5, owner decision 19) the shared-live pause flag read or written
//      anywhere but its authority, lib/safety/sharedLivePause.ts: a
//      `.sharedLivePaused` property access (readers interpret a pool row
//      through sharedLivePauseOf()), a `sharedLivePaused` property in a
//      .set() / .values() object (pauseSharedLive() / resumeSharedLive() are
//      the one scoped, operator-only, audited writer), or raw SQL naming
//      shared_live_paused. The authority's shape is checked too: it writes ONE
//      pool row by id, refuses a non-operator, audits in the same transaction
//      and never touches an install-wide switch.
//
// Every allowlist entry carries a reason. An entry whose file no longer
// needs it (or no longer exists) is reported as stale, so the lists only
// shrink. QA fixtures (__qa__, *.test.ts) and operator scripts (src/scripts)
// are not runtime and are exempt.
//
// Pure source analysis (TypeScript AST): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");

export const AUTHORITY = ["lib/safety/platformSwitches.ts", "lib/safety/tradingHalt.ts"] as const;
/** The one writer that engages the platform emergency stop (every settings row) and releases one selected stop (releasePlatformStop). */
export const STOP_ENGAGE_WRITER = "lib/safety/platformStopWriter.ts";
export const SAFETY_CORE_OWNER = "lib/safetyCore.ts";
export const ARMING_OWNER = "lib/live/liveArming.ts";
/** The shared-live pause authority (owner decision 19). */
export const SHARED_LIVE_PAUSE_AUTHORITY = "lib/safety/sharedLivePause.ts";

/** global_trading_settings columns that are safety switches (camel, as drizzle names them). */
export const SWITCH_COLUMNS = [
  "platformMode", "simulatedEnabled", "demoEnabled", "liveEnabled",
  "emergencyKillSwitch", "killSwitchEngagedAt", "killSwitchReason",
  "liveBrokerExecutionArmed", "liveBrokerExecutionArmedAt", "liveBrokerExecutionArmedBy", "liveBrokerExecutionArmedBridgeId",
] as const;
const SWITCH_COLUMN_SET = new Set<string>(SWITCH_COLUMNS);

/** Raw SQL that names a switch column (snake case) or reads the safety_core table. */
const RAW_SWITCH_SQL = /\b(emergency_kill_switch|kill_switch_engaged|live_broker_execution_armed)\b/;
const RAW_GTS_VENUE_SQL = /\bglobal_trading_settings\b[\s\S]*\b(platform_mode|live_enabled|demo_enabled|simulated_enabled|kill_switch_reason)\b|\b(platform_mode|live_enabled|demo_enabled|simulated_enabled|kill_switch_reason)\b[\s\S]*\bglobal_trading_settings\b/;
const RAW_SAFETY_CORE_SQL = /\b(from|join|update|into)\s+"?safety_core"?\b/i;

type Rule = "gts_column" | "gts_whole_row" | "gts_write" | "safety_core" | "arming" | "raw_row" | "env_flag" | "raw_sql" | "single_stop" | "stop_engage" | "stop_release" | "shared_live_pause";

/** A module specifier that names the safety-core owner (lib/safetyCore.ts). */
const SAFETY_CORE_MODULE = /(^|\/)safetyCore(\.js|\.ts)?$/;

/**
 * Reviewed exceptions: file → the rules it may break, and why. Writers are
 * the audited admin handlers; the rest is reviewed (each one is
 * listed in docs/TIER1_PLATFORM_SAFETY_SOURCE.md).
 */
export const ALLOW: Record<string, { rules: Rule[]; why: string }> = {
  // ── Writers (audited admin handlers) ──────────────────────────────────────
  "lib/safety/platformStopWriter.ts": { rules: ["gts_write"], why: "the one emergency-stop ENGAGE writer (engagePlatformStop: every settings row, reason/time/actor; its callers keep their own audit events) and the one RELEASE operation (releasePlatformStop: one selected stop, operator-only, audited in the same transaction; owner decision 1)" },
  "routes/adminTrading.ts": { rules: ["gts_write", "raw_row", "single_stop"], why: "audited admin writer: platform mode, routing, shared master; engages through engagePlatformStop() and releases through releasePlatformStop() (before/after audit snapshots need the raw row; single_stop: the emergency stop's own before/after audit snapshot)" },
  "routes/adminLiveSharedReadiness.ts": { rules: ["gts_whole_row", "gts_write", "single_stop"], why: "audited admin writer: activation, arm / disarm live execution, shared posture on kill switch (engages through engagePlatformStop(); the raw row is the write target and before/after audit snapshot; single_stop: the arm precondition kill_released, the activation handler and the readiness report's per-source fields name the emergency stop this handler writes; arming is not an order; activation never releases a stop, owner decision 1)" },
  "routes/adminLiveSharedActivation.ts": { rules: ["gts_whole_row", "gts_write", "single_stop"], why: "audited admin writer: shared live posture on rollback (engages the stop through engagePlatformStop(); single_stop: the emergency stop's before/after audit snapshot)" },
  "routes/adminMasterBridge.ts": { rules: ["gts_write"], why: "audited admin writer: master bridge snapshot / enable (no switch column)" },
  "routes/adminLiveFirstTestMode.ts": { rules: ["gts_write"], why: "audited admin writer: first-test-mode policy (no switch column)" },
  // ── Readers still to migrate ───────────────────────────────────────────────
  // ── Reviewed single-stop readers (rule 9) ──────────────────────────────────
  // Not pre-checks. Reports and readiness views read platformStop() (round 4);
  // the readers left name one stop for a reason given here. A pre-check that
  // refuses an order reads platformStop() + preCheckStopRefusal().
  // (round 5, owner decision 4: the envelope itself reads platformStopWith() and left this list)
  "lib/assistant/derivedEnvelope.ts": { rules: ["single_stop"], why: "Ruby's read-only projection of the envelope's labelled emergencyKillSwitch field (Ruby never executes); its allowOrderExecution / liveLocked / bannerReason come from the envelope, which derives them from platformStop()" },
  "lib/live/liveCommandPipeline.ts": { rules: ["single_stop"], why: "emergencyKillSwitchBlocksDispatch() is the pure dispatch pre-gate decision; its emergencyKillSwitch / safetyCoreKillSwitch inputs come from platformStop() + preCheckStopRefusal() at its one call site" },
  // Legacy gates the pre-trade Risk Governor does not run behind. Round 5
  // (owner decision 3): /mt5 command endpoints, /broker/reconnect and the paper
  // permission verdict are action-aware through platformStop() +
  // preCheckStopRefusal() and left this list. /execute-trade is being retired
  // (decision 14, another change) and stays listed until then.
  "routes/trades.ts": { rules: ["single_stop"], why: "legacy /execute-trade TOCTOU re-check of the safety core's own tradeGate snapshot (kill + mode + state); the path records into the paper book without the governor" },
  // ── Reviewed env-flag readers ──────────────────────────────────────────────
  "lib/live/phaseBConfig.ts": { rules: ["env_flag"], why: "Phase B master switch helpers (liveBrokerExecutionEnabled); the DB arm comes from the authority" },
  "lib/startup/envChecklist.ts": { rules: ["env_flag"], why: "boot env inventory reports the variable's state; never gates" },
};

/**
 * `emergencyKillSwitch: <not false>` (want "engaged") or `emergencyKillSwitch:
 * false` (want "released") in an object literal (spreads of literals
 * followed), or null.
 */
function stopProperty(e: ts.Expression, want: "engaged" | "released"): ts.Node | null {
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  if (!ts.isObjectLiteralExpression(x)) return null;
  for (const p of x.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = stopProperty(p.expression, want);
      if (inner) return inner;
      continue;
    }
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (name !== "emergencyKillSwitch") continue;
    const released = ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword;
    if (want === "released" && released) return p;
    if (want === "engaged" && !released && (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p))) return p;
  }
  return null;
}

/** A property named `name` in an object literal (spreads of literals followed), or null. */
function namedProperty(e: ts.Expression, name: string): ts.Node | null {
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  if (!ts.isObjectLiteralExpression(x)) return null;
  for (const p of x.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = namedProperty(p.expression, name);
      if (inner) return inner;
      continue;
    }
    if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p;
  }
  return null;
}

/** `<x>.emergencyKillSwitch` or `<x>["emergencyKillSwitch"]` as an assignment target. */
function isEmergencyFlagTarget(e: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "emergencyKillSwitch";
  if (ts.isElementAccessExpression(e)) return ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === "emergencyKillSwitch";
  return false;
}

export function scanFile(key: string, source: string): string[] {
  if ((AUTHORITY as readonly string[]).includes(key)) return [];
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const out = new Map<Rule, string>();
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const hit = (rule: Rule, node: ts.Node, msg: string) => { if (!out.has(rule)) out.set(rule, `${at(node)}: ${msg}`); };

  const alias = new Map<string, string>([
    ["globalTradingSettingsTable", "globalTradingSettingsTable"],
    ["safetyCoreTable", "safetyCoreTable"],
    ["arxLiveArmingTable", "arxLiveArmingTable"],
  ]);
  const tableOf = (e: ts.Expression | undefined): string | null => {
    if (!e) return null;
    if (ts.isIdentifier(e)) return alias.get(e.text) ?? null;
    if (ts.isPropertyAccessExpression(e) && alias.has(e.name.text)) return e.name.text;
    return null;
  };

  // Does this file get lib/safetyCore.ts (static or dynamic import)? Then a
  // `.killSwitchEngaged` read is the safety-core kill switch (getStatus()).
  let importsSafetyCore = false;
  const singleStop = (node: ts.Node, what: string) =>
    hit("single_stop", node, `reads one install-wide stop on its own (${what}); read both through platformStop() + preCheckStopRefusal() in lib/safety/platformSwitches.ts`);
  const killReads: ts.Node[] = [];
  const engageCalls: ts.Node[] = [];
  const resetCalls: ts.Node[] = [];
  let writesAudit = false;

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && SAFETY_CORE_MODULE.test(node.moduleSpecifier.text)) {
      importsSafetyCore = true;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && SAFETY_CORE_MODULE.test(node.arguments[0].text)) {
      importsSafetyCore = true;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "emergencyStop") singleStop(node, "the platform emergency stop, .emergencyStop");
      if (name === "emergencyKillSwitch" && tableOf(node.expression) !== "globalTradingSettingsTable") singleStop(node, "the platform emergency stop, .emergencyKillSwitch");
      if (name === "killSwitchEngaged" && key !== SAFETY_CORE_OWNER) killReads.push(node);
    }
    if (ts.isIdentifier(node) && node.text === "readSafetyCoreSwitch" && !ts.isImportSpecifier(node.parent)) {
      singleStop(node, "the safety-core kill switch, readSafetyCoreSwitch()");
    }
    if (ts.isImportSpecifier(node) && node.propertyName && alias.has(node.propertyName.text)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && alias.has(node.propertyName.text) && ts.isIdentifier(node.name)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      const t = alias.get(node.text);
      if (t === "safetyCoreTable" && key !== SAFETY_CORE_OWNER) {
        hit("safety_core", node, `references safetyCoreTable; read the safety-core kill switch through lib/safety/platformSwitches.ts (readSafetyCoreSwitch), write it through ${SAFETY_CORE_OWNER}`);
      }
      if (t === "arxLiveArmingTable" && key !== ARMING_OWNER) {
        hit("arming", node, `references arxLiveArmingTable; the trader's arming row and kill switch go through ${ARMING_OWNER} (getMyArming, engage/releaseKillSwitchForUser) and lib/safety/tradingHalt.ts`);
      }
    }
    if (ts.isIdentifier(node) && (node.text === "isLiveBrokerExecutionEnabledEnv") && !ts.isImportSpecifier(node.parent)) {
      hit("env_flag", node, "reads the ARX_LIVE_BROKER_EXECUTION_ENABLED helper directly; use lib/live/phaseBConfig.ts or readPlatformSwitches().liveBrokerExecution");
    }
    if (ts.isIdentifier(node) && node.text === "loadGlobalTradingSettingsRow" && !ts.isImportSpecifier(node.parent)) {
      hit("raw_row", node, "loads the raw settings row (switches included); read readPlatformSwitches() / getGlobalTradingConfig()");
    }
    if (ts.isPropertyAccessExpression(node) && SWITCH_COLUMN_SET.has(node.name.text) && tableOf(node.expression) === "globalTradingSettingsTable") {
      hit("gts_column", node, `reads global_trading_settings.${node.name.text}; read it through lib/safety/platformSwitches.ts (readPlatformSwitches)`);
    }
    // Relational query API (db.query.globalTradingSettingsTable.findFirst()) → the whole row.
    if (ts.isPropertyAccessExpression(node) && node.name.text === "globalTradingSettingsTable"
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query") {
      hit("gts_whole_row", node, "reads the whole global_trading_settings row (every switch); use loadPlatformSettings() (switches + switch-free config)");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const table = tableOf(node.arguments[0]);
      if (table === "globalTradingSettingsTable") {
        if (method === "from") {
          // select() with no column map → the whole row (every switch).
          const recv = node.expression.expression;
          if (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression)
            && (recv.expression.name.text === "select" || recv.expression.name.text === "selectDistinct") && recv.arguments.length === 0) {
            hit("gts_whole_row", node, "reads the whole global_trading_settings row (every switch); use loadPlatformSettings() (switches + switch-free config)");
          }
        }
        if (method === "update" || method === "insert" || method === "delete") {
          hit("gts_write", node, `${method}s global_trading_settings outside the reviewed admin writers`);
        }
      }
    }
    // 10. An engaged emergency stop written outside the one engage writer.
    if (key !== STOP_ENGAGE_WRITER) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "set" || node.expression.name.text === "values")) {
        for (const arg of node.arguments) {
          const engage = stopProperty(arg, "engaged");
          if (engage) hit("stop_engage", engage, "writes an engaged emergency stop (emergencyKillSwitch) outside the one engage writer; call engagePlatformStop() in lib/safety/platformStopWriter.ts (every settings row, audited by the caller)");
          const release = stopProperty(arg, "released");
          if (release) hit("stop_release", release, "writes a released emergency stop (emergencyKillSwitch: false) outside the one release operation; call releasePlatformStop() in lib/safety/platformStopWriter.ts (one selected stop, every settings row, operator-only, audited)");
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isEmergencyFlagTarget(node.left)) {
        if (node.right.kind !== ts.SyntaxKind.FalseKeyword) {
          hit("stop_engage", node, "sets an engaged emergency stop (emergencyKillSwitch) outside the one engage writer; call engagePlatformStop() in lib/safety/platformStopWriter.ts");
        } else {
          hit("stop_release", node, "releases the emergency stop (emergencyKillSwitch = false) outside the one release operation; call releasePlatformStop() in lib/safety/platformStopWriter.ts");
        }
      }
      if (ts.isIdentifier(node) && node.text === "resetKillSwitch" && key !== SAFETY_CORE_OWNER
        && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        resetCalls.push(node);
      }
      if (ts.isIdentifier(node) && node.text === "engagePlatformStop" && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        engageCalls.push(node);
      }
    }
    // 11. The shared-live pause flag outside its authority.
    if (key !== SHARED_LIVE_PAUSE_AUTHORITY) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "sharedLivePaused") {
        hit("shared_live_pause", node, `reads or writes the shared-live pause flag (.sharedLivePaused) outside its authority; read a pool row through sharedLivePauseOf() and pause / resume through pauseSharedLive() / resumeSharedLive() in ${SHARED_LIVE_PAUSE_AUTHORITY}`);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "set" || node.expression.name.text === "values")) {
        for (const arg of node.arguments) {
          const p = namedProperty(arg, "sharedLivePaused");
          if (p) hit("shared_live_pause", p, `reads or writes the shared-live pause flag (sharedLivePaused in a write) outside its authority; pause / resume through pauseSharedLive() / resumeSharedLive() in ${SHARED_LIVE_PAUSE_AUTHORITY} (one pool row, operator-only, audited)`);
        }
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\bshared_live_paused\b/.test(node.text)) {
        hit("shared_live_pause", node, `reads or writes the shared-live pause flag (raw SQL shared_live_paused) outside its authority; go through ${SHARED_LIVE_PAUSE_AUTHORITY}`);
      }
    }
    if (ts.isIdentifier(node) && node.text === "adminActionAuditLogTable" && !ts.isImportSpecifier(node.parent)) writesAudit = true;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if (RAW_SWITCH_SQL.test(text) || RAW_GTS_VENUE_SQL.test(text) || RAW_SAFETY_CORE_SQL.test(text)) {
        hit("raw_sql", node, "raw SQL names a safety switch column or the safety_core table; read it through lib/safety/platformSwitches.ts");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (importsSafetyCore && killReads[0]) singleStop(killReads[0], "the safety-core kill switch, getStatus().killSwitchEngaged");
  if (importsSafetyCore && resetCalls[0]) {
    hit("stop_release", resetCalls[0], "releases the safety-core kill switch (resetKillSwitch()) outside the one release operation; call releasePlatformStop({ stop: \"safety_core_kill_switch\" }) in lib/safety/platformStopWriter.ts (operator-only, audited)");
  }
  if (engageCalls[0] && !writesAudit) {
    hit("stop_engage", engageCalls[0], "calls engagePlatformStop() without writing admin_action_audit_log; every emergency-stop engage is audited by its caller");
  }

  const allowed = ALLOW[key]?.rules ?? [];
  return [...out].filter(([rule]) => !allowed.includes(rule)).map(([, msg]) => msg);
}

/** Allowlist entries that no longer match anything (or whose file is gone). */
export function staleEntries(read: (key: string) => string | null): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(ALLOW)) {
    const src = read(key);
    if (src == null) { out.push(`${key}: allowlisted but the file no longer exists — remove the entry`); continue; }
    const saved = ALLOW[key]!;
    ALLOW[key] = { rules: [], why: saved.why };
    let found: string[];
    try { found = scanFile(key, src); } finally { ALLOW[key] = saved; }
    for (const rule of entry.rules) {
      if (!found.some((v) => ruleOfMessage(v) === rule)) out.push(`${key}: allowlisted for "${rule}" but no longer breaks it — remove it from the entry`);
    }
  }
  return out;
}

const MESSAGE_RULE: [RegExp, Rule][] = [
  [/^\d+: reads global_trading_settings\./, "gts_column"],
  [/^\d+: reads the whole global_trading_settings row/, "gts_whole_row"],
  [/^\d+: (update|insert|delete)s global_trading_settings/, "gts_write"],
  [/^\d+: references safetyCoreTable/, "safety_core"],
  [/^\d+: references arxLiveArmingTable/, "arming"],
  [/^\d+: loads the raw settings row/, "raw_row"],
  [/^\d+: reads the ARX_LIVE_BROKER_EXECUTION_ENABLED helper/, "env_flag"],
  [/^\d+: raw SQL names a safety switch/, "raw_sql"],
  [/^\d+: reads one install-wide stop on its own/, "single_stop"],
  [/^\d+: (writes|sets) an engaged emergency stop|^\d+: calls engagePlatformStop\(\) without/, "stop_engage"],
  [/^\d+: (writes a released|releases the) (emergency stop|safety-core kill switch)/, "stop_release"],
  [/^\d+: reads or writes the shared-live pause flag/, "shared_live_pause"],
];
export function ruleOfMessage(msg: string): Rule | null {
  for (const [re, rule] of MESSAGE_RULE) if (re.test(msg)) return rule;
  return null;
}

/** The authority must keep its contract: strict multi-row combine and fail-closed reads. */
export function checkAuthorityShape(read: (key: string) => string | null): string[] {
  const out: string[] = [];
  const sw = read("lib/safety/platformSwitches.ts");
  const halt = read("lib/safety/tradingHalt.ts");
  if (!sw) return ["lib/safety/platformSwitches.ts is missing (the switch read authority)"];
  if (!halt) return ["lib/safety/tradingHalt.ts is missing (the stop-switch authority)"];
  if (!/export async function readPlatformSwitches\(/.test(sw)) out.push("platformSwitches.ts lost readPlatformSwitches()");
  if (!/export function switchesFromRows\(/.test(sw)) out.push("platformSwitches.ts lost switchesFromRows() (the strict multi-row combine)");
  if (!/rows\.find\(\(r\) => r\.emergencyKillSwitch !== false\)/.test(sw)) out.push("platformSwitches.ts: the emergency stop must be engaged when ANY row says so (rows.find(... !== false))");
  if (!/function failClosed\(/.test(sw)) out.push("platformSwitches.ts lost its fail-closed answer");
  if (!/export async function platformStop\(/.test(sw)) out.push("platformSwitches.ts lost platformStop() (both install-wide stops, one answer)");
  if (!/export function preCheckStopRefusal\(/.test(sw)) out.push("platformSwitches.ts lost preCheckStopRefusal() (which stop sources refuse a pre-check's action)");
  if (!/platformStopFrom\(sw, sc\)/.test(sw) || !/\["platform_emergency_stop", "safety_core_kill_switch"\]/.test(sw)) out.push("platformSwitches.ts: platformStop() must combine both reads and fail closed on both sources when a read throws");
  if (!/await platformStop\(\)/.test(halt)) out.push("tradingHalt.ts must read the install-wide stops through platformStop()");
  if (!/export async function venueTradingVerdict\(/.test(halt)) out.push("tradingHalt.ts lost venueTradingVerdict() (may this venue trade now, and why not)");
  if (!/from "\.\/platformSwitches\.js"/.test(halt)) out.push("tradingHalt.ts must read the install-wide switches through ./platformSwitches.js");
  return out;
}

/** The engage writer must keep its contract: every row, the three stop fields and the actor, no row filter. */
export function checkStopWriterShape(read: (key: string) => string | null): string[] {
  const w = read(STOP_ENGAGE_WRITER);
  if (!w) return [`${STOP_ENGAGE_WRITER} is missing (the one emergency-stop engage writer)`];
  const out: string[] = [];
  if (!/export async function engagePlatformStop\(/.test(w)) out.push(`${STOP_ENGAGE_WRITER} lost engagePlatformStop()`);
  const m = /\.update\(globalTradingSettingsTable\)([\s\S]*?)\.returning\(\)/.exec(w);
  if (!m) out.push(`${STOP_ENGAGE_WRITER}: engagePlatformStop() must update global_trading_settings and return the rows`);
  else {
    if (/\.where\(/.test(m[1]!)) out.push(`${STOP_ENGAGE_WRITER}: the engage write must set EVERY settings row (no .where()); the reader says engaged when any row does`);
    for (const f of ["emergencyKillSwitch: true", "killSwitchEngagedAt:", "killSwitchReason:", "updatedByAdminId:"]) {
      if (!m[1]!.includes(f)) out.push(`${STOP_ENGAGE_WRITER}: the engage write must set ${f.replace(":", "")}`);
    }
  }
  // Release (owner decision 1): one selected stop, every row, reason/time
  // cleared, operator-only, audited in the same transaction, never arming.
  const fn = /export async function releasePlatformStop\(([\s\S]*?)\n}\n/.exec(w);
  if (!fn) out.push(`${STOP_ENGAGE_WRITER} lost releasePlatformStop() (the one audited release)`);
  else {
    const body = fn[1]!;
    if (!/operatorRoleFromSession\(/.test(body)) out.push(`${STOP_ENGAGE_WRITER}: releasePlatformStop() must refuse a non-operator actor (operatorRoleFromSession)`);
    const r = /tx\.update\(globalTradingSettingsTable\)([\s\S]*?)\.returning\(\)/.exec(body);
    if (!r) out.push(`${STOP_ENGAGE_WRITER}: releasePlatformStop() must update global_trading_settings inside its transaction`);
    else {
      if (/\.where\(/.test(r[1]!)) out.push(`${STOP_ENGAGE_WRITER}: the release write must clear EVERY settings row (no .where())`);
      for (const f of ["emergencyKillSwitch: false", "killSwitchEngagedAt: null", "killSwitchReason: null", "updatedByAdminId:"]) {
        if (!r[1]!.includes(f)) out.push(`${STOP_ENGAGE_WRITER}: the release write must set ${f}`);
      }
      if (/liveBrokerExecutionArmed|platformMode|liveEnabled|demoEnabled/.test(r[1]!)) out.push(`${STOP_ENGAGE_WRITER}: the release write must not arm or open anything (no live arm / mode / venue column)`);
    }
    if (!/tx\.insert\(adminActionAuditLogTable\)/.test(body)) out.push(`${STOP_ENGAGE_WRITER}: the emergency-stop release must write its audit row in the same transaction`);
    if (!/resetKillSwitch\(/.test(body)) out.push(`${STOP_ENGAGE_WRITER}: the safety-core release must go through its owner (lib/safetyCore.ts resetKillSwitch)`);
  }
  return out;
}

/** The shared-live pause authority must keep its contract: one pool row by id, operator-only, audited, never install-wide. */
export function checkSharedLivePauseShape(read: (key: string) => string | null): string[] {
  const a = read(SHARED_LIVE_PAUSE_AUTHORITY);
  if (!a) return [`${SHARED_LIVE_PAUSE_AUTHORITY} is missing (the shared-live pause authority)`];
  const out: string[] = [];
  for (const fn of ["pauseSharedLive", "resumeSharedLive"]) {
    const m = new RegExp(`export async function ${fn}\\(([\\s\\S]*?)\\n}\\n`).exec(a);
    if (!m) { out.push(`${SHARED_LIVE_PAUSE_AUTHORITY} lost ${fn}()`); continue; }
    const body = m[1]!;
    if (!/operatorRoleFromSession\(/.test(body)) out.push(`${SHARED_LIVE_PAUSE_AUTHORITY}: ${fn}() must refuse a non-operator actor (operatorRoleFromSession)`);
    const w = /tx\.update\(arxMasterBridgePoolTable\)([\s\S]*?)\.returning\(\)/.exec(body);
    if (!w) out.push(`${SHARED_LIVE_PAUSE_AUTHORITY}: ${fn}() must update the pool row inside its transaction`);
    else if (!/\.where\(eq\(arxMasterBridgePoolTable\.id, scope\.poolId\)\)\s*$/.test(w[1]!)) out.push(`${SHARED_LIVE_PAUSE_AUTHORITY}: ${fn}() must write ONE pool row, .where(eq(arxMasterBridgePoolTable.id, scope.poolId)) (never install-wide)`);
    if (!/tx\.insert\(adminActionAuditLogTable\)/.test(body)) out.push(`${SHARED_LIVE_PAUSE_AUTHORITY}: ${fn}() must write its audit row in the same transaction`);
  }
  if (!/export function sharedLivePauseOf\(/.test(a)) out.push(`${SHARED_LIVE_PAUSE_AUTHORITY} lost sharedLivePauseOf() (the one reader of the flag)`);
  if (/globalTradingSettingsTable|safetyCore|liveBrokerExecutionArmed|engagePlatformStop|releasePlatformStop/.test(a.replace(/^\s*\/\/.*$/gm, ""))) {
    out.push(`${SHARED_LIVE_PAUSE_AUTHORITY}: the shared-live pause must stay scoped to its pool and never touch an install-wide switch`);
  }
  return out;
}

export function checkSingleSafetySwitchSource(): CheckResult {
  const violations: string[] = [];
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  const read = (key: string) => {
    const p = join(API_SRC, key);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  for (const s of staleEntries(read)) violations.push(`stale allowlist: ${s}`);
  for (const s of checkAuthorityShape(read)) violations.push(s);
  for (const s of checkStopWriterShape(read)) violations.push(s);
  for (const s of checkSharedLivePauseShape(read)) violations.push(s);
  return {
    name: "single-safety-switch-source",
    ok: violations.length === 0,
    violations,
    notes: [`safety switches read only through ${AUTHORITY.join(" + ")}; emergency stop engaged and stops released only through ${STOP_ENGAGE_WRITER}; shared-live pause read and written only through ${SHARED_LIVE_PAUSE_AUTHORITY}; ${Object.keys(ALLOW).length} reviewed exceptions`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleSafetySwitchSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
