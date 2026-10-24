// ── One paper book authority (Tier 1, docs/TIER1_PAPER_BOOK.md) ──────────
//
// Every simulated (paper) table has exactly ONE runtime writer module:
//
//   paper_orders, paper_trade_events → lib/tradeEngine/paperVenue.ts
//       The canonical simulated-position book. The trader's ticket (Trade
//       Engine pipeline, mode PAPER), the Build EE autopilot and monitor, and
//       the operator auto-debrief fixture all book here.
//   paper_trades → routes/mePaperTrades.ts
//       The trader's paper trade JOURNAL (prices the trader types in). A
//       separate concept, not a second position book; governed by
//       lib/riskGovernor/journal.ts. Never books into the venue.
//   trades → lib/trades/paperBook.ts
//       The legacy /execute-trade simulated record (no broker order), the
//       bot emergency-stop cancel, and Position Guardian management.
//
// The guard fails when:
//   1. any other runtime file inserts, updates or deletes one of those tables
//      (drizzle calls through aliases / destructuring / element access, or
//      raw SQL);
//   2. a book function is called from a file not listed for it (BOOK_API);
//   3. a paperVenue function that writes paper_orders is not either governed
//      (Risk Governor with venue PAPER and the expected action, called before
//      the first write) or a listed venue settlement that only moves status,
//      exit and P&L (never size, side, symbol, stop or target, never inserts);
//   4. paperBook.applyPaperManagement changes signature (the Position Guardian
//      exit door depends on it), or the journal imports a booking module;
//   5. an allowlist entry is stale.
//
// Scope: runtime files under artifacts/api-server/src. Operator one-off
// scripts (src/scripts, scripts/src backfills), __qa__ and *.test.ts are not
// runtime. Pure source analysis (TypeScript AST): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const PAPER_VENUE = "lib/tradeEngine/paperVenue.ts";
export const PAPER_JOURNAL = "routes/mePaperTrades.ts";
export const LEGACY_BOOK = "lib/trades/paperBook.ts";
export const PIPELINE = "lib/tradeEngine/pipeline.ts";
export const GUARDIAN_EXIT_DOOR = "lib/positionGuardian/manage.ts";

/** Each paper table and the one module allowed to write it. */
export const TABLE_OWNERS: Record<string, { physical: string; owner: string; role: string }> = {
  paperOrdersTable: { physical: "paper_orders", owner: PAPER_VENUE, role: "canonical simulated-position book" },
  paperTradeEventsTable: { physical: "paper_trade_events", owner: PAPER_VENUE, role: "paper order event trail" },
  paperTradesTable: { physical: "paper_trades", owner: PAPER_JOURNAL, role: "paper trade journal (trader-entered)" },
  tradesTable: { physical: "trades", owner: LEGACY_BOOK, role: "legacy /execute-trade simulated record" },
};
const OWNER_OF_PHYSICAL = new Map(Object.entries(TABLE_OWNERS).map(([t, v]) => [v.physical, t] as const));
const RAW_WRITE =
  /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:"?public"?\s*\.\s*)?"?(paper_orders|paper_trade_events|paper_trades|trades)"?(?=[\s(;]|$)/i;

/** Book functions and the files allowed to call them. */
export const BOOK_API: Record<string, { module: string; callers: string[] }> = {
  // The trader's ticket reaches the venue only through the pipeline.
  openPaperOrder: { module: PAPER_VENUE, callers: [PIPELINE] },
  modifyPaperOrder: { module: PAPER_VENUE, callers: [PIPELINE] },
  closePaperOrder: { module: PAPER_VENUE, callers: [PIPELINE] },
  // Caller-priced fills and venue settlement: also only through the pipeline
  // (fillPaperTrade / settlePaperTrade / voidPaperTrade), which Build EE's
  // autopilot and monitor and the operator QA fixture call.
  openPaperFill: { module: PAPER_VENUE, callers: [PIPELINE] },
  closePaperFill: { module: PAPER_VENUE, callers: [PIPELINE] },
  settlePaperOrder: { module: PAPER_VENUE, callers: [PIPELINE] },
  voidPaperOrder: { module: PAPER_VENUE, callers: [PIPELINE] },
  // Legacy simulated-trade book.
  applyPaperManagement: { module: LEGACY_BOOK, callers: [GUARDIAN_EXIT_DOOR] },
  recordLegacyExecuteTrade: { module: LEGACY_BOOK, callers: ["routes/trades.ts"] },
  cancelOpenLegacyTrades: { module: LEGACY_BOOK, callers: ["routes/bot.ts"] },
};

/** paperVenue functions that write paper_orders behind the Risk Governor, and the action they must govern. */
export const GOVERNED_VENUE_FUNCTIONS: Record<string, "OPEN" | "MODIFY" | "CLOSE"> = {
  openPaperOrder: "OPEN",
  modifyPaperOrder: "MODIFY",
  closePaperOrder: "CLOSE",
  openPaperFill: "OPEN",
  closePaperFill: "CLOSE",
};
/**
 * paperVenue functions that write paper_orders WITHOUT a governor call, on
 * purpose: they fill or roll back an order the governor already allowed.
 * They may only update status / exit / P&L / timestamps.
 */
export const SETTLEMENT_FUNCTIONS: Record<string, string> = {
  settlePaperOrder: "venue exit fill: stop/target hit, QA fixture forced result",
  voidPaperOrder: "rollback of an order the caller booked a moment ago and lost an idempotency race on",
};
const SETTLEMENT_KEYS = new Set(["status", "closedAt", "exitPrice", "profitLoss", "updatedAt"]);
/** Modules the journal may never import: a journal row never books. */
const BOOKING_MODULES = /(?:tradeEngine\/|trades\/paperBook|paperExecution\/|live\/|mt5\/demoCommandQueue|positions\/governedOps)/;

type Line = (n: ts.Node) => number;
/** Own-key lookup, so names like "constructor" or "toString" never match. */
const own = <T>(rec: Record<string, T>, k: string): T | undefined => (Object.hasOwn(rec, k) ? rec[k] : undefined);

function tableResolver(file: ts.SourceFile) {
  const alias = new Map<string, string>();
  for (const t of Object.keys(TABLE_OWNERS)) alias.set(t, t);
  const collect = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName && own(TABLE_OWNERS, node.propertyName.text)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName)
      && own(TABLE_OWNERS, node.propertyName.text) && ts.isIdentifier(node.name)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  return (expr: ts.Expression | undefined): string | null => {
    if (!expr) return null;
    if (ts.isIdentifier(expr)) return alias.get(expr.text) ?? null;
    if (ts.isPropertyAccessExpression(expr) && own(TABLE_OWNERS, expr.name.text)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)
      && own(TABLE_OWNERS, expr.argumentExpression.text)) return expr.argumentExpression.text;
    return null;
  };
}

interface Write { table: string; op: string; node: ts.Node; call?: ts.CallExpression }

function findWrites(file: ts.SourceFile, root: ts.Node = file): Write[] {
  const tableOf = tableResolver(file);
  const out: Write[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["insert", "update", "delete"].includes(node.expression.name.text)) {
      const table = tableOf(node.arguments[0]);
      if (table) out.push({ table, op: node.expression.name.text, node, call: node });
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const m = RAW_WRITE.exec(node.text);
      if (m) {
        const verb = m[1]!.toLowerCase();
        const op = verb.startsWith("insert") ? "insert" : verb.startsWith("delete") ? "delete" : verb.startsWith("truncate") ? "truncate" : "update";
        const isSql = op !== "update" || /\bset\b/i.test(node.text) || !ts.isStringLiteral(node);
        if (isSql) out.push({ table: OWNER_OF_PHYSICAL.get(m[2]!.toLowerCase())!, op: `raw SQL ${op}`, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Violations in one runtime file, keyed by its path under artifacts/api-server/src. */
export function scanFile(key: string, source: string): string[] {
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const line: Line = (n) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
  const out = new Set<string>();
  for (const w of findWrites(file)) {
    const owner = TABLE_OWNERS[w.table]!;
    if (owner.owner !== key) {
      out.add(`${line(w.node)}: ${w.op} on ${owner.physical} — the ${owner.role} is written only by ${owner.owner}`);
    }
  }
  const visit = (node: ts.Node): void => {
    let name: string | null = null;
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) name = e.text;
      else if (ts.isPropertyAccessExpression(e)) name = e.name.text;
      else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) name = e.argumentExpression.text;
    }
    const api = name ? own(BOOK_API, name) : undefined;
    if (name && api) {
      if (api.module !== key && !api.callers.includes(key)) {
        out.add(`${line(node)}: calls ${name} (${api.module}) — only ${api.callers.join(", ")} may`);
      }
    }
    if (key === PAPER_JOURNAL) {
      const spec = ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]
          && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null;
      if (spec && BOOKING_MODULES.test(spec)) out.add(`${line(node)}: the paper journal imports a booking module "${spec}"; a journal row never books`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...out];
}

function topKeys(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : "<computed>"));
}

/** Structural proofs on the PAPER venue and the legacy book. */
export function checkBookShape(read: (key: string) => string | null): string[] {
  const v: string[] = [];
  const venueSrc = read(PAPER_VENUE);
  if (venueSrc == null) return [`${PAPER_VENUE} missing`];
  const file = ts.createSourceFile(PAPER_VENUE, venueSrc, ts.ScriptTarget.Latest, true);
  const seen = new Set<string>();
  for (const st of file.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
    const fn = st.name.text;
    const writes = findWrites(file, st.body).filter((w) => w.table === "paperOrdersTable");
    if (!writes.length) continue;
    seen.add(fn);
    const action = own(GOVERNED_VENUE_FUNCTIONS, fn);
    if (action) {
      let gateAt = -1;
      const find = (n: ts.Node): void => {
        if (gateAt < 0 && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "enforcePreTradeRisk") {
          const arg = n.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            const prop = (k: string) => arg.properties.find((p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === k);
            const venue = prop("venue")?.initializer;
            const act = prop("action")?.initializer;
            if (venue && ts.isStringLiteral(venue) && venue.text === "PAPER" && act && ts.isStringLiteral(act) && act.text === action) {
              gateAt = n.getStart(file);
            }
          }
        }
        ts.forEachChild(n, find);
      };
      find(st.body);
      if (gateAt < 0) v.push(`${PAPER_VENUE}: ${fn} writes paper_orders without the Risk Governor (venue "PAPER", action "${action}")`);
      else if (writes.some((w) => w.node.getStart(file) < gateAt)) v.push(`${PAPER_VENUE}: ${fn} writes paper_orders before its Risk Governor check`);
      continue;
    }
    if (own(SETTLEMENT_FUNCTIONS, fn)) {
      for (const w of writes) {
        if (w.op !== "update") { v.push(`${PAPER_VENUE}: settlement ${fn} may only update paper_orders (found ${w.op})`); continue; }
        // db.update(t).set({...}) — the .set( argument is the parent call of this one.
        const setCall = w.call?.parent && ts.isPropertyAccessExpression(w.call.parent) && w.call.parent.name.text === "set"
          && ts.isCallExpression(w.call.parent.parent) ? w.call.parent.parent : null;
        const arg = setCall?.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) { v.push(`${PAPER_VENUE}: settlement ${fn} must use a literal .set({...})`); continue; }
        const bad = topKeys(arg).filter((k) => !SETTLEMENT_KEYS.has(k));
        if (bad.length) v.push(`${PAPER_VENUE}: settlement ${fn} sets [${bad.join(", ")}]; a settlement only moves status, exit and P&L`);
      }
      continue;
    }
    v.push(`${PAPER_VENUE}: ${fn} writes paper_orders but is neither a governed venue function nor a listed settlement`);
  }
  for (const fn of [...Object.keys(GOVERNED_VENUE_FUNCTIONS), ...Object.keys(SETTLEMENT_FUNCTIONS)]) {
    if (!seen.has(fn)) v.push(`stale venue entry: ${PAPER_VENUE} ${fn} no longer writes paper_orders — update check-single-paper-book`);
  }
  // Arrow functions / methods hiding writes would escape the per-function check.
  const topLevelWrites = findWrites(file).filter((w) => w.table === "paperOrdersTable");
  for (const w of topLevelWrites) {
    let p: ts.Node | undefined = w.node;
    while (p && !ts.isFunctionDeclaration(p)) p = p.parent;
    if (!p) v.push(`${PAPER_VENUE}: a paper_orders write outside a named function declaration cannot be proven governed`);
  }

  const book = read(LEGACY_BOOK);
  if (book == null) v.push(`${LEGACY_BOOK} missing`);
  else if (!/export\s+async\s+function\s+applyPaperManagement\s*\(\s*tradeId:\s*number,\s*step:\s*PaperManagementStep\s*\)/.test(book)) {
    v.push(`${LEGACY_BOOK}: applyPaperManagement(tradeId: number, step: PaperManagementStep) is what the Position Guardian exit door calls — keep its signature`);
  }
  return v;
}

export function checkSinglePaperBook(): CheckResult {
  const violations: string[] = [];
  const writers = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/") || !/\.tsx?$/.test(key)) continue;
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const v of scanFile(key, src)) violations.push(`${rel(file)}:${v}`);
    const sf = ts.createSourceFile(key, src, ts.ScriptTarget.Latest, true);
    for (const w of findWrites(sf)) {
      if (!writers.has(w.table)) writers.set(w.table, new Set());
      writers.get(w.table)!.add(key);
    }
    for (const [fn, api] of Object.entries(BOOK_API)) {
      if (api.callers.includes(key) && new RegExp(`\\b${fn}\\s*\\(`).test(src)) {
        if (!callers.has(fn)) callers.set(fn, new Set());
        callers.get(fn)!.add(key);
      }
    }
  }
  for (const [table, { owner, physical }] of Object.entries(TABLE_OWNERS)) {
    if (!writers.get(table)?.has(owner)) violations.push(`${owner} no longer writes ${physical} — update check-single-paper-book and docs/TIER1_PAPER_BOOK.md`);
  }
  for (const [fn, api] of Object.entries(BOOK_API)) {
    for (const c of api.callers) {
      if (!callers.get(fn)?.has(c)) violations.push(`stale BOOK_API caller: ${c} no longer calls ${fn} — remove it`);
    }
  }
  const readKey = (k: string) => (existsSync(join(API_SRC, k)) ? readFileSync(join(API_SRC, k), "utf8") : null);
  violations.push(...checkBookShape(readKey));
  return {
    name: "single-paper-book",
    ok: violations.length === 0,
    violations,
    notes: [
      `${scanned} runtime files scanned; paper_orders + paper_trade_events → ${PAPER_VENUE}; ` +
        `paper_trades (journal) → ${PAPER_JOURNAL}; trades (legacy record) → ${LEGACY_BOOK}; ` +
        `${Object.keys(GOVERNED_VENUE_FUNCTIONS).length} governed venue functions, ${Object.keys(SETTLEMENT_FUNCTIONS).length} settlements`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkSinglePaperBook();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
