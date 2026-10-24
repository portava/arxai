// Position Guardian is the one authority for managing open positions.
//
// Every engine that manages an open position is a registered guardian rule
// (artifacts/api-server/src/lib/positionGuardian/rules.ts). This guard fails
// when:
//   1. a registered module is missing, or listed under two rules,
//   2. a rule module reaches an execution path itself (Trade Action Center
//      draft/confirm, governed ops, the live or demo queues, a direct call to
//      the instant router, the paper book, a simulated-trade or command-table
//      write) instead of
//      going through lib/positionGuardian/manage.ts,
//   3. an advisory rule imports the guardian's exit door,
//   4. an acting rule asks the exit door to act under another rule's id,
//   5. any module other than the exit door applies a paper management step,
//      or an unregistered runtime module both reads open positions and calls an
//      execution entry, unless it is one of the listed order-entry surfaces
//      (a trader's own action, the Trade Engine itself, platform safety).
// QA fixtures (__qa__, *.test.ts) and src/scripts (operator one-offs) are exempt.
//
// Pure source analysis: no network, no DB.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";
import {
  GUARDIAN_MANAGE_MODULE,
  GUARDIAN_RULES,
  type GuardianRule,
} from "../../../artifacts/api-server/src/lib/positionGuardian/rules.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const RULES = GUARDIAN_RULES as readonly GuardianRule[];
/** Defines applyPaperManagement; only the exit door calls it. */
const PAPER_BOOK = "lib/trades/paperBook.ts";

/**
 * Module specifiers a rule module may not import (value imports). Any module
 * under tradeEngine/ (the pipeline and its PAPER venue) counts: the alternative
 * used to require the specifier to END in "tradeEngine/", so
 * "../tradeEngine/pipeline.js" slipped through.
 */
const EXECUTION_MODULES =
  /(?:(?:tradeAction\/(?:create|confirm|route)|trades\/paperBook|positions\/governedOps|live\/liveCommandPipeline|mt5\/demoCommandQueue|mt5\/mt5CommandQueue)(?:\.js)?$|(?:^|\/)tradeEngine\/)/;
/** Calls that execute or persist a trade change. */
const EXECUTION_CALLS = new Set([
  "createActionDraft", "confirmAction", "routeConfirmedAction",
  "executeInstant", "submitGovernedModify", "submitGovernedClose",
  "createLiveOpsDraft", "createLiveDraft", "confirmLiveCommand", "dispatchLiveCommand",
  "createDraftCommand", "confirmCommand", "dispatchApprovedCommand", "queueMt5CommandWithGate",
  "applyPaperManagement",
  // The Trade Engine (lib/tradeEngine/pipeline.ts): submitTrade, its staged
  // contract, its one-click LIVE channel and its caller-priced PAPER fills.
  "submitTrade", "draftTrade", "confirmTrade", "dispatchTrade",
  "submitInstantTrade", "fillPaperTrade", "settlePaperTrade", "voidPaperTrade",
]);
const GUARDIAN_CALLS = new Set(["guardianRestoreStop", "guardianTradeActionClose", "guardianInstantManage", "guardianPaperManage"]);
const WRITE_TABLES = new Set(["tradesTable", "arxLiveCommandsTable", "mt5DemoCommandsTable", "mt5CommandsTable"]);

/**
 * Unregistered modules that may read positions and execute: they act on a
 * trader's explicit request, are the execution pipeline, or are platform
 * safety (kill switch / live test cycle), not autonomous management.
 */
export const ORDER_ENTRY_SURFACES: Record<string, string> = {
  "lib/tradeAction/route.ts": "Trade Action Center router (trader-confirmed actions)",
  "lib/assistant/tools.ts": "assistant tools: trader-confirmed actions",
  "routes/meAssistant.ts": "assistant route: trader-confirmed actions",
  "lib/live/instantTrade.ts": "the instant-trade router itself",
  "lib/live/liveCommandPipeline.ts": "the live command pipeline itself",
  "lib/live/emergencyClose.ts": "platform safety: emergency close-all",
  "lib/live/liveTestCycle.ts": "platform safety: operator live test cycle",
  "routes/livePositions.ts": "trader's own close/modify buttons",
  "routes/tradesLiveShared.ts": "trader's own close/modify buttons",
  "routes/meLive.ts": "trader's own close/modify buttons",
  "routes/meTrades.ts": "trader's own close/modify buttons (My Trades)",
};

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

interface ScanFacts {
  violations: string[];
  importsManage: boolean;
  readsPositions: boolean;
  executes: boolean;
  ruleIds: string[];
}

export function scanSource(key: string, source: string): ScanFacts {
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const facts: ScanFacts = { violations: [], importsManage: false, readsPositions: false, executes: false, ruleIds: [] };
  const line = (n: ts.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
  const spec = (s: string) => {
    if (/positionGuardian\/manage(?:\.js)?$/.test(s) || (key.startsWith("lib/positionGuardian/") && /^\.\/manage(?:\.js)?$/.test(s))) facts.importsManage = true;
    if (/positions\/(?:ledger|openPositions)(?:\.js)?$/.test(s)) facts.readsPositions = true;
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const s = node.moduleSpecifier.text;
      spec(s);
      if (EXECUTION_MODULES.test(s) && !node.importClause?.isTypeOnly) {
        facts.violations.push(`${line(node)}: imports execution module "${s}"`);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const s = node.arguments[0].text;
        spec(s);
        if (EXECUTION_MODULES.test(s)) facts.violations.push(`${line(node)}: imports execution module "${s}"`);
      }
      if (name && (EXECUTION_CALLS.has(name) || name === "executor")) {
        facts.executes = true;
        facts.violations.push(`${line(node)}: calls ${name}() directly; act through ${GUARDIAN_MANAGE_MODULE}`);
      }
      if (name && GUARDIAN_CALLS.has(name)) facts.executes = true;
      if (name && (name === "update" || name === "insert") && node.arguments[0] && ts.isIdentifier(node.arguments[0]) &&
          WRITE_TABLES.has(node.arguments[0].text)) {
        // Command-status transitions (reconcilers, consumers) are not position
        // management; creating a command or changing a simulated trade is.
        if (name === "insert" || node.arguments[0].text === "tradesTable") facts.executes = true;
        facts.violations.push(`${line(node)}: writes ${node.arguments[0].text} directly; act through ${GUARDIAN_MANAGE_MODULE}`);
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "ruleId" &&
        ts.isStringLiteralLike(node.initializer)) {
      facts.ruleIds.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return facts;
}

/** Violations for one registered rule module. */
export function scanRuleModule(rule: GuardianRule, key: string, source: string): string[] {
  const f = scanSource(key, source);
  const out = [...f.violations];
  if (rule.kind === "ADVISORY" && f.importsManage) {
    out.push(`advisory rule "${rule.id}" imports ${GUARDIAN_MANAGE_MODULE}; advisory rules never act`);
  }
  for (const id of f.ruleIds) {
    if (id !== rule.id) out.push(`acts under rule "${id}" but is registered as "${rule.id}"`);
  }
  return out;
}

/** Violations for one runtime module that is not a registered rule. */
export function scanUnregistered(key: string, source: string): string[] {
  if (key === GUARDIAN_MANAGE_MODULE || ORDER_ENTRY_SURFACES[key]) return [];
  const f = scanSource(key, source);
  const out: string[] = [];
  if (f.importsManage || f.ruleIds.length) out.push(`uses the guardian exit door but is not a registered guardian rule`);
  if (key !== PAPER_BOOK && /\bapplyPaperManagement\s*\(/.test(source)) out.push(`calls applyPaperManagement; simulated-trade management goes through ${GUARDIAN_MANAGE_MODULE}`);
  if (f.readsPositions && f.executes) {
    out.push(`reads open positions and executes trade changes: register it as a Position Guardian rule in lib/positionGuardian/rules.ts`);
  }
  return out;
}

export function checkSinglePositionGuardian(): CheckResult {
  const violations: string[] = [];
  const owner = new Map<string, string>();
  for (const rule of RULES) {
    if (rule.kind === "ADVISORY" && (rule.actions.length || rule.route)) violations.push(`advisory rule "${rule.id}" lists actions`);
    if (rule.kind === "ACTING" && (!rule.actions.length || !rule.route)) violations.push(`acting rule "${rule.id}" has no actions/route`);
    for (const m of rule.modules) {
      if (owner.has(m)) violations.push(`${m} is registered under "${owner.get(m)}" and "${rule.id}"`);
      owner.set(m, rule.id);
      if (!existsSync(join(API_SRC, m))) violations.push(`${m} (rule "${rule.id}") is missing`);
    }
  }
  if (!existsSync(join(API_SRC, GUARDIAN_MANAGE_MODULE))) violations.push(`${GUARDIAN_MANAGE_MODULE} missing`);

  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/") || !/\.tsx?$/.test(key)) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    const ruleId = owner.get(key);
    const rule = ruleId ? RULES.find((r) => r.id === ruleId)! : null;
    const found = rule ? scanRuleModule(rule, key, src) : scanUnregistered(key, src);
    for (const v of found) violations.push(`${rel(file)}: ${v}`);
  }
  return {
    name: "single-position-guardian",
    ok: violations.length === 0,
    violations,
    notes: [
      `${RULES.length} guardian rules (${RULES.filter((r) => r.kind === "ACTING").length} acting, ` +
        `${RULES.filter((r) => r.kind === "ADVISORY").length} advisory) over ${owner.size} modules; ` +
        `${scanned} runtime files scanned; one exit door ${GUARDIAN_MANAGE_MODULE}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkSinglePositionGuardian();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
