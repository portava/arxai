// One source for the Risk Governor's limits (Tier 1 Risk Governor).
//
// The numbers the pre-trade Risk Governor enforces live in two stores:
// user_risk_settings (the trader's own limits) and user_risk_limits (the
// operator's hard limits for that trader). The governor resolves them with
// its platform ceilings, strictest wins (resolveEffectiveLimits). A file
// that reads those rows itself, or compares a value against a limit with
// its own numbers, can disagree with what the governor enforces (different
// row, different default, admin cap ignored, daily-loss switch ignored). So,
// outside the authority, this guard fails on:
//
//   1. table     — any reference to userRiskSettingsTable / userRiskLimitsTable
//                  outside lib/riskGovernor/limitSettings.ts (the one reader)
//                  that is not a write (select, query API, column refs);
//   2. write     — insert / update / delete on either table outside the
//                  reviewed writers (the settings pages, presets, the admin
//                  risk-limits handler, the governor's get-or-create);
//   3. raw_sql   — raw SQL naming user_risk_settings / user_risk_limits;
//   4. raw_reader — a call to a reader of the trader's OWN saved values
//                  (readTraderRiskSettings[Many], readOperatorRiskLimits[Many],
//                  getOrCreateRiskSettings, getOrCreateUserRiskSettings)
//                  outside lib/riskGovernor. Those return what was saved, not
//                  the limit in force; a caller that decides or shows "the
//                  limit" should read loadEffectiveLimits() /
//                  loadStoredLimitRows() + explainLimitLayers(). Each reviewed
//                  reader is listed below with what it does with the value;
//   5. limit_eval — a comparison (<, <=, >, >=) against a property named like
//                  a Risk Governor limit (maxLotSize, maxPositionSize,
//                  maxDailyLoss*, maxOpenTrades, maxTradesPerDay,
//                  maxRiskPerTrade*, maxDrawdownPercent, maxPortfolioRiskPercent,
//                  maxPositionsPerSymbol, maxLeverage, maxSymbolLeverage,
//                  cooldownAfterLossMinutes, maxConsecutiveLosses,
//                  maxWeeklyLoss*, minRewardRiskRatio, and the live / self-trade
//                  lane caps maxOpenPositions, maxConcurrentPositions,
//                  maxLotPerTrade, maxLotConfirmed, maxLot, dailyLossLimitUsd,
//                  maxExposurePerSymbolLots) outside lib/riskGovernor.
//                  Limit evaluation belongs to the governor (preTrade.ts).
//
// Every allowlist entry carries a reason; an entry whose file no longer
// needs a rule (or no longer exists) is reported as stale, so the lists only
// shrink. QA fixtures (__qa__, *.test.ts) and operator scripts (src/scripts)
// are exempt.
//
// Pure source analysis (TypeScript AST): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");

export const AUTHORITY = "lib/riskGovernor/limitSettings.ts";
export const GOVERNOR_DIR = "lib/riskGovernor/";

const TABLES = new Set(["userRiskSettingsTable", "userRiskLimitsTable"]);
const RAW_READERS = new Set([
  "readTraderRiskSettings", "readTraderRiskSettingsMany", "readOperatorRiskLimits", "readOperatorRiskLimitsMany",
  "getOrCreateRiskSettings", "getOrCreateUserRiskSettings",
]);
export const LIMIT_FIELD = /^(maxOpenPositions|maxConcurrentPositions|maxLotPerTrade|maxLotConfirmed|maxLot|dailyLossLimitUsd|maxExposurePerSymbolLots|maxLotSize|maxPositionSize|maxDailyLoss\w*|maxOpenTrades|maxTradesPerDay|maxRiskPerTrade\w*|maxDrawdownPercent|maxPortfolioRiskPercent|maxPositionsPerSymbol|maxLeverage|maxSymbolLeverage|cooldownAfterLossMinutes|maxConsecutiveLosses|maxWeeklyLoss\w*|minRewardRiskRatio)$/;
const RAW_SQL = /\b(from|join|update|into)\s+"?user_risk_(settings|limits)\b/i;
const COMPARE = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

export type Rule = "table" | "write" | "raw_sql" | "raw_reader" | "limit_eval";

/**
 * Reviewed exceptions: file → the rules it may break, and why. Categories
 * (docs/TIER1_RISK_GOVERNOR_SOURCE.md): (a) stricter-only pre-check that runs
 * before the governor and only adds refusals, (b) display / report / alert,
 * (c) duplicate decision with a different basis (owner decision or listed).
 */
export const ALLOW: Record<string, { rules: Rule[]; why: string }> = {
  // ── Audited writers ────────────────────────────────────────────────────────
  "lib/riskGovernor/riskEvents.ts": { rules: ["write"], why: "governor: getOrCreateRiskSettings inserts the trader's default row (reads through limitSettings)" },
  "lib/riskGovernor/riskProfile.ts": { rules: ["write"], why: "governor: applyRiskPreset / configurePropFirm write the trader's own row; the governor still bounds it by operator and platform limits" },
  "lib/risk/userRiskSettings.ts": { rules: ["write", "raw_reader"], why: "the older settings page's store: splits a write into user_risk_settings (limits) and risk_settings (preferences); reads the row through readTraderRiskSettings to compose the page (shows saved values)" },
  "routes/meRiskGovernor.ts": { rules: ["write", "raw_reader", "limit_eval"], why: "the Risk Governor settings page: upserts the trader's row (write); /me/risk/status, /daily-status and the post-close hooks show the limits in force (owner decision 8: `effective`, from effectiveLimitViews, with the saved preference and the override reason) against paper_trades history; the post-close hooks still compare the trader's saved caps (warning-level events, never a block; paper_trades vs paper_orders basis is owner decision 7); the settings endpoints read the saved row to edit it" },
  "routes/adminTrading.ts": { rules: ["write", "raw_reader"], why: "audited admin risk-limits handler: writes user_risk_limits and reads the row first for the before/after audit snapshot" },
  // ── (a) Stricter-only pre-checks before the governor ───────────────────────
  "lib/adminTrading/orderGuard.ts": { rules: ["raw_reader", "limit_eval"], why: "(a) order guard step 6 runs before its own pre_trade_risk step (enforcePreTradeRisk) and only adds refusals: NO_RISK_LIMITS_CONFIGURED, admin max lot, symbol / direction / account type; step 6b is the separately named operational rate cap (owner decision 9: APPROVED commands in a rolling 24h, OPERATIONAL_RATE_CAP_REACHED, never called trades per day). The daily-trade limit itself is the governor's (9b)" },
  "lib/autopilot.ts": { rules: ["limit_eval"], why: "(a) in-memory autopilot session rules (max open positions / max trades of the session's own config) decide whether to propose an order; every order it makes goes through oms.placeOrder, which runs enforcePreTradeRisk" },
  "lib/live/liveCommandPipeline.ts": { rules: ["limit_eval"], why: "(a) live lane: the arming-time confirmed max lot (arx_live_arming) refuses at draft time, before the Risk Governor pre-gate at dispatch; the live lane's other caps (governance, master live access, arx_live_user_settings) are their own stores, listed in the doc" },
  "lib/live/liveArming.ts": { rules: ["limit_eval"], why: "(a) arming checklist item 13: the confirmed max lot must be > 0 and <= 1.0 (Phase A) before a trader can arm; not an order decision" },
  // ── (b) Display / report / alert / advisory (never gate an order) ──────────
  "lib/assistant/tools.ts": { rules: ["raw_reader", "limit_eval"], why: "(b) Ruby read-only tools: getRiskLimits returns the trader's saved row; the prop-challenge compliance summary compares challenge config (prop_challenges, not a governor limit); Ruby never executes" },
  "lib/assistant/coachTools.ts": { rules: ["raw_reader"], why: "(b) Ruby coach: plan scoring and trading-style profile read the trader's saved row (advice, never a gate)" },
  "lib/reportBuilder.ts": { rules: ["raw_reader"], why: "(b) user report: prints the trader's saved settings row" },
  "routes/meDashboard.ts": { rules: ["raw_reader", "limit_eval"], why: "(b) dashboard: the risk card, cooldown and approaching-cap copy show the limits in force (owner decision 8, effectiveLimitViews); the trade-quality score still grades closed paper_trades against the saved risk % / R:R (getOrCreateRiskSettings); display only" },
  "routes/health.ts": { rules: ["raw_reader"], why: "(b) personal health: riskGovernor.configured = the trader saved a row" },
  "routes/adminAllocations.ts": { rules: ["raw_reader"], why: "(b) admin allocations table: the at-risk flag's daily-loss cap is the first positive of arx_live_user_settings, master live access, then user_risk_limits.max_daily_loss_usd (the live lane's own precedence, display only)" },
  "routes/riskProfile.ts": { rules: ["raw_reader"], why: "(b) risk profile page: shows the saved preset next to the governor's effective limits (riskOverview)" },
  "routes/risk.ts": { rules: ["raw_reader"], why: "(b) older settings page: GET/PATCH /risk/settings, /risk/audit report and the position-size calculator read the saved values (the stateless /risk/guards/* calculators take numbers from the request)" },
  "routes/executionConfirmations.ts": { rules: ["raw_reader"], why: "(b) execution confirmation checklist: compares the ticket with the trader's saved max lot / risk % (advisory checklist row; the order itself still faces the governor)" },
  "routes/liveIntent.ts": { rules: ["limit_eval"], why: "(b) live-intent capture: tester-side caps (TESTER_CAPS); never places an order" },
  "routes/propChallenges.ts": { rules: ["limit_eval"], why: "(b) prop-challenge evaluator: compares paper orders with the challenge's own config (prop_challenges), not a governor limit" },
  "routes/ruleContracts.ts": { rules: ["limit_eval"], why: "(b) accountability contracts: soft violations against the trader's own contract (trading_rule_contracts), never a gate" },
  "lib/marketDataLayer.ts": { rules: ["limit_eval"], why: "(b) evaluateRisk advisory verdict with caller-supplied maxDailyLossUsd; single-risk-authority bans it from the order path" },
  "lib/missionRiskState.ts": { rules: ["limit_eval"], why: "(b) mission facts (budget used %) against the mission's own budget; the verdict is riskGovernor/missionScope" },
  "lib/paperSession/manager.ts": { rules: ["limit_eval"], why: "(b) paper-session status (checkSessionAllows*), exposed only as a status route; compares the session's own rules (paper_sessions), not a governor limit" },
  "lib/riskAudit.ts": { rules: ["limit_eval"], why: "(c) computeRiskAudit: daily / weekly loss, trade count, open trades and losing streak from the legacy trades table against the caller's saved values; used by /risk/audit (report) and the legacy /mt5/execute gate. Legacy trades vs paper_orders is an owner decision" },
  // ── (c) Duplicate decisions on a different basis (listed, not unified) ────
  "routes/mt5.ts": { rules: ["raw_reader"], why: "(c) legacy /mt5/execute risk approval via computeRiskAudit on the trader's saved values and the legacy trades table; commands on this path are stored BLOCKED (paper-only lock) and no governor runs here. Owner decision (legacy trades basis)" },
  "routes/permission.ts": { rules: ["raw_reader"], why: "(c) paper permission verdict (evaluatePermission, @workspace/domain) on the trader's saved values, not the effective limits (operator caps and the daily-loss switch not applied); unifying would change the verdict — listed in the doc" },
  "routes/tradeDecision.ts": { rules: ["raw_reader", "limit_eval"], why: "(c) advisory trade-decision orchestrator: open trades (paper_orders OPEN) / losing streak vs the trader's saved values, and trades today from the governor's PAPER activity (loadTradingActivity, owner decision 9); adds blocker lines, places nothing. Listed in the doc" },
};

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) { e = e.expression; continue; }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) { e = e.left; continue; }
    return e;
  }
}

export function scanFile(key: string, source: string): string[] {
  if (key === AUTHORITY) return [];
  const inGovernor = key.startsWith(GOVERNOR_DIR);
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const out = new Map<Rule, string>();
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const hit = (rule: Rule, node: ts.Node, msg: string) => { if (!out.has(rule)) out.set(rule, `${at(node)}: ${msg}`); };

  const alias = new Map<string, string>([...TABLES].map((t) => [t, t]));
  const tableOf = (e: ts.Node | undefined): string | null => {
    if (!e) return null;
    if (ts.isIdentifier(e)) return alias.get(e.text) ?? null;
    if (ts.isPropertyAccessExpression(e) && TABLES.has(e.name.text)) return e.name.text;
    return null;
  };
  const inTypeQuery = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p)) return true;
      if (ts.isStatement(p)) return false;
    }
    return false;
  };
  // A write's whole call chain (db.update(T).set(..).where(eq(T.userId, ..)))
  // belongs to the write, column refs in its where clause included.
  const writeChains = new Set<ts.Node>();
  const chainRoot = (call: ts.Node): ts.Node => {
    let n = call;
    while (n.parent && ((ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
      || (ts.isCallExpression(n.parent) && n.parent.expression === n) || ts.isAwaitExpression(n.parent))) n = n.parent;
    return n;
  };
  const inWrite = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (writeChains.has(p)) return true;
    return false;
  };

  function visit(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && node.propertyName && TABLES.has(node.propertyName.text)) alias.set(node.name.text, node.propertyName.text);
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && TABLES.has(node.propertyName.text) && ts.isIdentifier(node.name)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const t = tableOf(node.arguments[0]);
      if (t && (method === "insert" || method === "update" || method === "delete")) {
        writeChains.add(chainRoot(node));
        hit("write", node, `${method}s ${t === "userRiskSettingsTable" ? "user_risk_settings" : "user_risk_limits"} outside the reviewed writers`);
      }
    }
    const isTableRef = (ts.isIdentifier(node) && alias.has(node.text) && !ts.isImportSpecifier(node.parent) && !ts.isBindingElement(node.parent)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
      || (ts.isPropertyAccessExpression(node) && TABLES.has(node.name.text));
    if (isTableRef && !inWrite(node) && !inTypeQuery(node)) {
      hit("table", node, `reads ${tableOf(node)} directly; read it through ${AUTHORITY} (readTraderRiskSettings / readOperatorRiskLimits / loadStoredLimitRows / loadEffectiveLimits)`);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (RAW_SQL.test(node.text)) hit("raw_sql", node, `raw SQL names a Risk Governor limit table; read it through ${AUTHORITY}`);
    }
    if (!inGovernor) {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
        if (callee && RAW_READERS.has(callee)) {
          hit("raw_reader", node, `reads the trader's saved limit row (${callee}), not the limit in force; use loadEffectiveLimits() (or loadStoredLimitRows() + explainLimitLayers()) from lib/riskGovernor`);
        }
      }
      if (ts.isBinaryExpression(node) && COMPARE.has(node.operatorToken.kind)) {
        for (const side of [node.left, node.right]) {
          const e = unwrap(side);
          if (ts.isPropertyAccessExpression(e) && LIMIT_FIELD.test(e.name.text)) {
            hit("limit_eval", node, `compares against a risk limit (${e.name.text}) outside the Risk Governor; the governor (lib/riskGovernor/preTrade.ts) evaluates limits`);
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

  const allowed = ALLOW[key]?.rules ?? [];
  return [...out].filter(([rule]) => !allowed.includes(rule)).map(([rule, msg]) => `${msg} [${rule}]`);
}

export function ruleOfMessage(msg: string): Rule | null {
  const m = msg.match(/\[(table|write|raw_sql|raw_reader|limit_eval)\]$/);
  return (m?.[1] as Rule | undefined) ?? null;
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

/** The authority must keep its contract: the readers, the governor reading through them, the early lot cap reading the ceiling. */
export function checkAuthorityShape(read: (key: string) => string | null): string[] {
  const out: string[] = [];
  const auth = read(AUTHORITY);
  const enforce = read("lib/riskGovernor/enforce.ts");
  const preTrade = read("lib/riskGovernor/preTrade.ts");
  const guards = read("lib/tradeAction/guards.ts");
  if (!auth) return [`${AUTHORITY} is missing (the one reader of the Risk Governor's limit settings)`];
  for (const fn of ["readTraderRiskSettings", "readTraderRiskSettingsMany", "readOperatorRiskLimits", "readOperatorRiskLimitsMany", "loadStoredLimitRows", "loadEffectiveLimits"]) {
    if (!new RegExp(`export async function ${fn}\\(`).test(auth)) out.push(`${AUTHORITY} lost ${fn}()`);
  }
  if (!/resolveEffectiveLimits\(await loadStoredLimitRows\(userId\)\)/.test(auth)) out.push(`${AUTHORITY}: loadEffectiveLimits() must resolve the stored rows with resolveEffectiveLimits (strictest wins)`);
  if (!enforce) out.push("lib/riskGovernor/enforce.ts is missing");
  else {
    if (!/from "\.\/limitSettings\.js"/.test(enforce)) out.push("enforce.ts must read limits through ./limitSettings.js");
    if (!/await loadEffectiveLimits\(intent\.userId\)/.test(enforce)) out.push("enforce.ts: the governor must load the limits in force with loadEffectiveLimits(intent.userId)");
  }
  if (!preTrade || !/export function resolveEffectiveLimits\(/.test(preTrade)) out.push("preTrade.ts lost resolveEffectiveLimits() (strictest of trader, operator and platform)");
  if (guards && !/MAX_LOT_HARD_CAP = PLATFORM_RISK_CEILINGS\.maxLotSize/.test(guards)) {
    out.push("lib/tradeAction/guards.ts: the early lot hard cap must read PLATFORM_RISK_CEILINGS.maxLotSize (the governor's ceiling), not its own number");
  }
  // Owner decision 10: one R:R calculation. Rule 13 and the ticket pre-check
  // both call checkRewardRiskFloor; the draft route reads the floor in force.
  if (preTrade && !/checkRewardRiskFloor\(D\.minRewardRiskRatio,/.test(preTrade)) {
    out.push("preTrade.ts: rule 13 must measure the trader's R:R floor with checkRewardRiskFloor(D.minRewardRiskRatio, ...)");
  }
  const ticket = read("lib/tradeAction/riskGovernorEnforcement.ts");
  if (ticket && !/checkRewardRiskFloor\(/.test(ticket)) {
    out.push("lib/tradeAction/riskGovernorEnforcement.ts: the ticket R:R floor must use the governor's checkRewardRiskFloor (owner decision 10)");
  }
  const draft = read("routes/pendingOrderDraft.ts");
  if (draft && !/loadEffectiveLimits\(userId\)\)\.discipline\.minRewardRiskRatio/.test(draft)) {
    out.push("routes/pendingOrderDraft.ts: the R:R floor must be the limit in force, loadEffectiveLimits(userId).discipline.minRewardRiskRatio (owner decision 10)");
  }
  // Owner decision 9: the order guard's rolling-24h count is the operational
  // rate cap, its own gate and reason, never "trades per day".
  const orderGuard = read("lib/adminTrading/orderGuard.ts");
  if (orderGuard && (/TRADES_PER_DAY/.test(orderGuard) || !/name: "operational_rate_cap"/.test(orderGuard) || !/OPERATIONAL_RATE_CAP_REACHED/.test(orderGuard))) {
    out.push("lib/adminTrading/orderGuard.ts: the rolling-24h approved-command count must be the separately named operational_rate_cap gate (OPERATIONAL_RATE_CAP_REACHED), never a TRADES_PER_DAY reason (owner decision 9)");
  }
  if (preTrade && !/export function tradingDayStart\(/.test(preTrade)) {
    out.push("preTrade.ts lost tradingDayStart() (the governor's trading day, owner decision 9)");
  }
  // Owner decision 8: status views show the limit in force. The daily-loss
  // cap in money is the governor's dailyLossCapAmount, not a view's own formula.
  if (preTrade && !/export function dailyLossCapAmount\(/.test(preTrade)) {
    out.push("preTrade.ts lost dailyLossCapAmount() (the enforced daily-loss cap in money, owner decision 8)");
  }
  for (const f of ["routes/portfolioRisk.ts", "lib/readiness/traderReadiness.ts", "lib/alerts/ruleEngine.ts"]) {
    const src = read(f);
    if (src && !/dailyLossCapAmount\(/.test(src)) out.push(`${f}: the daily-loss cap shown must be the governor's dailyLossCapAmount(effective limits, equity) (owner decision 8)`);
  }
  const shell = read("routes/meAccountShell.ts");
  if (shell && !/effectiveLimitViews\(/.test(shell)) out.push("routes/meAccountShell.ts: the risk view must show the limits in force (effectiveLimitViews) next to the saved preference (owner decision 8)");
  return out;
}

export function checkSingleRiskLimitSource(): CheckResult {
  const violations: string[] = [];
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    scanned++;
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  const read = (key: string) => {
    const p = join(API_SRC, key);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  for (const s of staleEntries(read)) violations.push(`stale allowlist: ${s}`);
  for (const s of checkAuthorityShape(read)) violations.push(s);
  return {
    name: "single-risk-limit-source",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; limit settings read only through ${AUTHORITY}; limits evaluated only in ${GOVERNOR_DIR}; ${Object.keys(ALLOW).length} reviewed exceptions`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleRiskLimitSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
