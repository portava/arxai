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
//   8. raw SQL naming a switch column or the safety_core table.
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
export const SAFETY_CORE_OWNER = "lib/safetyCore.ts";
export const ARMING_OWNER = "lib/live/liveArming.ts";

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

type Rule = "gts_column" | "gts_whole_row" | "gts_write" | "safety_core" | "arming" | "raw_row" | "env_flag" | "raw_sql";

/**
 * Reviewed exceptions: file → the rules it may break, and why. Writers are
 * the audited admin handlers; the rest is reviewed (each one is
 * listed in docs/TIER1_PLATFORM_SAFETY_SOURCE.md).
 */
export const ALLOW: Record<string, { rules: Rule[]; why: string }> = {
  // ── Writers (audited admin handlers) ──────────────────────────────────────
  "routes/adminTrading.ts": { rules: ["gts_write", "raw_row"], why: "audited admin writer: platform mode, emergency stop, routing, shared master (before/after audit snapshots need the raw row)" },
  "routes/adminLiveSharedReadiness.ts": { rules: ["gts_whole_row", "gts_write"], why: "audited admin writer: activation, arm / disarm live execution (the raw row is the write target and before/after audit snapshot; its switch checks read the authority)" },
  "routes/adminLiveSharedActivation.ts": { rules: ["gts_whole_row", "gts_write"], why: "audited admin writer: shared live activation (engages the stop on rollback)" },
  "routes/adminMasterBridge.ts": { rules: ["gts_write"], why: "audited admin writer: master bridge snapshot / enable (no switch column)" },
  "routes/adminLiveFirstTestMode.ts": { rules: ["gts_write"], why: "audited admin writer: first-test-mode policy (no switch column)" },
  // ── Readers still to migrate ───────────────────────────────────────────────
  // ── Reviewed env-flag readers ──────────────────────────────────────────────
  "lib/live/phaseBConfig.ts": { rules: ["env_flag"], why: "Phase B master switch helpers (liveBrokerExecutionEnabled); the DB arm comes from the authority" },
  "lib/startup/envChecklist.ts": { rules: ["env_flag"], why: "boot env inventory reports the variable's state; never gates" },
};

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

  function visit(node: ts.Node): void {
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
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      if (RAW_SWITCH_SQL.test(text) || RAW_GTS_VENUE_SQL.test(text) || RAW_SAFETY_CORE_SQL.test(text)) {
        hit("raw_sql", node, "raw SQL names a safety switch column or the safety_core table; read it through lib/safety/platformSwitches.ts");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

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
  if (!/export async function venueTradingVerdict\(/.test(halt)) out.push("tradingHalt.ts lost venueTradingVerdict() (may this venue trade now, and why not)");
  if (!/from "\.\/platformSwitches\.js"/.test(halt)) out.push("tradingHalt.ts must read the install-wide switches through ./platformSwitches.js");
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
  return {
    name: "single-safety-switch-source",
    ok: violations.length === 0,
    violations,
    notes: [`safety switches read only through ${AUTHORITY.join(" + ")}; ${Object.keys(ALLOW).length} reviewed exceptions`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleSafetySwitchSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
