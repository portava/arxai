// ── Trade Engine: one pipeline, LIVE / DEMO / PAPER are modes of it ──────
//
// lib/tradeEngine/pipeline.ts (submitTrade) is the one entry for opening,
// closing and modifying a trade in any mode. It delegates to the governed
// path that already exists for each mode and adds/removes no gate:
//
//   LIVE  → liveCommandPipeline (Phase B, the only live writer)
//   DEMO  → demoCommandQueue (draft → confirm → dispatch)
//   LIVE/DEMO close & modify → lib/positions/governedOps
//   PAPER → lib/tradeEngine/paperVenue (paper simulator book)
//
// This guard fails when a runtime file outside that pipeline:
//   1. calls a venue entry point (demo queue draft/confirm/dispatch, live
//      draft/confirm/dispatch, governed position ops, the PAPER venue)
//      without being a listed producer below;
//   2. writes a paper/legacy trade book (paper_orders, paper_trades, trades)
//      without being a listed producer;
//   3. inserts into a command table (arx_live_commands, mt5_demo_commands,
//      mt5_commands) outside its owner — the legacy mt5_commands mailbox keeps
//      its non-trade writers and ONE explicit trade exception: the My Trades
//      DEMO close (risk-reducing, Risk Governor-checked, CLOSE only).
// It also checks that the pipeline still dispatches every mode, writes
// nothing itself, and that the PAPER venue still runs the Risk Governor.
//
// A listed producer is a known, reviewed path that predates the pipeline
// (staged draft/confirm APIs, autopilots, legacy books). A new one fails
// until it either goes through submitTrade or is reviewed into this list.
// Operator scripts under src/scripts, __qa__ and *.test.ts are not runtime.
//
// Pure source analysis (TypeScript AST): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const PIPELINE = "lib/tradeEngine/pipeline.ts";
export const PAPER_VENUE = "lib/tradeEngine/paperVenue.ts";

type Entry = "DEMO_QUEUE" | "LIVE_PIPELINE" | "LIVE_INSTANT" | "GOVERNED_OPS" | "PAPER_VENUE";

/** Venue entry points: calling one creates or changes exposure on that venue. */
export const ENTRY_POINTS: Record<Entry, { names: string[]; owner: string }> = {
  DEMO_QUEUE: { names: ["createDraftCommand", "confirmCommand", "dispatchApprovedCommand"], owner: "lib/mt5/demoCommandQueue.ts" },
  LIVE_PIPELINE: { names: ["createLiveDraft", "createLiveOpsDraft", "confirmLiveCommand", "dispatchLiveCommand"], owner: "lib/live/liveCommandPipeline.ts" },
  LIVE_INSTANT: { names: ["executeInstant"], owner: "lib/live/instantTrade.ts" },
  GOVERNED_OPS: { names: ["submitGovernedClose", "submitGovernedModify"], owner: "lib/positions/governedOps.ts" },
  PAPER_VENUE: { names: ["openPaperOrder", "modifyPaperOrder", "closePaperOrder"], owner: PAPER_VENUE },
};
const ENTRY_OF = new Map<string, Entry>(
  (Object.entries(ENTRY_POINTS) as [Entry, { names: string[] }][]).flatMap(([k, v]) => v.names.map((n) => [n, k] as const)),
);

/** Files allowed to call venue entry points directly, and why. */
export const ENTRY_PRODUCERS: Record<string, { entries: Entry[]; why: string }> = {
  [PIPELINE]: { entries: ["DEMO_QUEUE", "LIVE_PIPELINE", "GOVERNED_OPS", "PAPER_VENUE"], why: "the one pipeline" },
  "lib/positions/governedOps.ts": { entries: ["DEMO_QUEUE", "LIVE_PIPELINE"], why: "the LIVE/DEMO position-op leg of the pipeline" },
  // Staged LIVE producers: draft, confirm and dispatch are separate steps
  // (often separate requests) inside the Phase B pipeline's own gates.
  "lib/live/instantTrade.ts": { entries: ["LIVE_PIPELINE"], why: "executeInstant: one-click live entry for missions, self-trade and the assistant" },
  "lib/live/liveTestCycle.ts": { entries: ["LIVE_PIPELINE"], why: "operator live test cycle (dry-run preview cancels its draft)" },
  "lib/live/emergencyClose.ts": { entries: ["LIVE_PIPELINE"], why: "risk-reducing emergency close" },
  "routes/tradesLiveShared.ts": { entries: ["LIVE_PIPELINE"], why: "shared-master live ticket (writes attribution before dispatch)" },
  "routes/meLive.ts": { entries: ["LIVE_PIPELINE"], why: "staged live draft / confirm / dispatch API" },
  "routes/meOneClick.ts": { entries: ["LIVE_PIPELINE"], why: "one-click live API" },
  "routes/meTrades.ts": { entries: ["LIVE_PIPELINE"], why: "My Trades LIVE close (risk-reducing)" },
  // executeInstant callers: the one-click live entry (itself a Phase B
  // producer above) for automation and the assistant.
  "lib/missionExecution.ts": { entries: ["LIVE_INSTANT"], why: "mission entry (mission gate only adds strictness)" },
  "lib/missionExitManager.ts": { entries: ["LIVE_INSTANT"], why: "mission protective exit (Position Guardian work)" },
  "lib/selfTrade/agentExecutor.ts": { entries: ["LIVE_INSTANT"], why: "self-trade agent entry" },
  "routes/instantTrade.ts": { entries: ["LIVE_INSTANT"], why: "one-click instant trade API" },
  "routes/meAssistant.ts": { entries: ["LIVE_INSTANT"], why: "assistant-confirmed trade (idempotency + evidence wrapper)" },
  // Staged DEMO producer.
  "routes/meDemoCommands.ts": { entries: ["DEMO_QUEUE"], why: "staged demo draft / confirm / dispatch API" },
  // The Position Guardian exit door: every acting guardian rule reaches
  // execution only through it, after its registry checks (never widens a
  // stop, never opens, never adds size). Guarded by check-single-position-guardian.
  "lib/positionGuardian/manage.ts": { entries: ["GOVERNED_OPS", "LIVE_INSTANT"], why: "Position Guardian exit door (stop restore, governed management)" },
};

/** Paper / legacy trade books. */
export const PAPER_TABLES = ["paperOrdersTable", "paperTradesTable", "tradesTable"] as const;
/** Command tables: their owners insert; lifecycle updates are check-execution-single-entry's job. */
export const COMMAND_TABLES: Record<string, string[]> = {
  arxLiveCommandsTable: ["lib/live/liveCommandPipeline.ts"],
  mt5DemoCommandsTable: ["lib/mt5/demoCommandQueue.ts"],
  mt5CommandsTable: [
    "lib/live/liveCommandPipeline.ts", // Phase B's EA bridge mirror
    "routes/meTrades.ts", // EXCEPTION: My Trades DEMO close (see MAILBOX_EXCEPTION)
    "routes/mt5.ts", // legacy queue, forced BLOCKED
    "routes/brokerHealth.ts", // operator RECONNECT request
    "routes/meMt5Commands.ts", // allow-listed read-only EA requests
  ],
};
const PHYSICAL: Record<string, string> = {
  paper_orders: "paperOrdersTable", paper_trades: "paperTradesTable", trades: "tradesTable",
  arx_live_commands: "arxLiveCommandsTable", mt5_demo_commands: "mt5DemoCommandsTable", mt5_commands: "mt5CommandsTable",
};
const RAW_WRITE = /\b(insert\s+into|update|delete\s+from)\s+(?:"?public"?\s*\.\s*)?"?(paper_orders|paper_trades|trades|arx_live_commands|mt5_demo_commands|mt5_commands)"?(?=[\s(]|$)/i;

/**
 * The one trade writer into the legacy mt5_commands mailbox outside Phase B:
 * the My Trades DEMO close. It is risk-reducing (CLOSE only), checked by the
 * Risk Governor before the insert, and LIVE closes return earlier through
 * Phase B. Kept deliberately (owner decision); documented in
 * docs/TIER1_TRADE_ENGINE_MODES.md.
 */
export const MAILBOX_EXCEPTION = "routes/meTrades.ts";

/** Files allowed to write paper / legacy trade books, and why. */
export const PAPER_WRITERS: Record<string, { tables: (typeof PAPER_TABLES)[number][]; why: string }> = {
  [PAPER_VENUE]: { tables: ["paperOrdersTable"], why: "PAPER mode of the pipeline (Risk Governor on open/modify/close; SL/TP hits are venue fills)" },
  "lib/paperExecution/paperExecutionService.ts": { tables: ["paperOrdersTable"], why: "decision-driven paper autopilot open (Risk Governor)" },
  "lib/paperExecution/paperExecutionMonitor.ts": { tables: ["paperOrdersTable"], why: "paper autopilot monitor: SL/TP fills and governed manual close" },
  "routes/autoDebrief.ts": { tables: ["paperOrdersTable"], why: "operator QA fixture order (Risk Governor)" },
  "routes/mePaperTrades.ts": { tables: ["paperTradesTable"], why: "paper trade journal (governed open and stop/target edits)" },
  "routes/trades.ts": { tables: ["tradesTable"], why: "legacy /execute-trade simulated record (Safety Core gate); no broker order" },
  "routes/bot.ts": { tables: ["tradesTable"], why: "emergency stop cancels the trader's own legacy rows (risk-reducing)" },
  "lib/trades/paperBook.ts": { tables: ["tradesTable"], why: "simulated-trade management (applyPaperManagement), called only by the Position Guardian exit door lib/positionGuardian/manage.ts" },
};

/** Violations in one runtime file, keyed by its path under artifacts/api-server/src. */
export function scanFile(key: string, source: string): string[] {
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const fail = (node: ts.Node, reason: string) => out.add(`${at(node)}: ${reason}`);

  // Import aliases for the tables we track (import { x as y }).
  const alias = new Map<string, string>();
  const tracked = new Set<string>([...PAPER_TABLES, ...Object.keys(COMMAND_TABLES)]);
  for (const t of tracked) alias.set(t, t);

  const producer = ENTRY_PRODUCERS[key];
  const tableOf = (expr: ts.Expression | undefined): string | null => {
    if (!expr) return null;
    if (ts.isIdentifier(expr)) return alias.get(expr.text) ?? null;
    if (ts.isPropertyAccessExpression(expr) && tracked.has(expr.name.text)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression) && tracked.has(expr.argumentExpression.text)) {
      return expr.argumentExpression.text;
    }
    return null;
  };

  function checkEntryName(node: ts.Node, name: string): void {
    const entry = ENTRY_OF.get(name);
    if (!entry) return;
    if (ENTRY_POINTS[entry].owner === key) return;
    if (producer?.entries.includes(entry)) return;
    fail(node, `calls ${name} (${entry}) directly — submit through ${PIPELINE} (submitTrade), or review it into ENTRY_PRODUCERS`);
  }

  function checkWrite(node: ts.Node, op: string, table: string): void {
    if ((PAPER_TABLES as readonly string[]).includes(table)) {
      const w = PAPER_WRITERS[key];
      if (!w || !w.tables.includes(table as (typeof PAPER_TABLES)[number])) {
        fail(node, `${op} on ${table} — paper trades go through ${PIPELINE} (mode PAPER)`);
      }
      return;
    }
    if (op === "insert" && !(COMMAND_TABLES[table] ?? []).includes(key)) {
      fail(node, `inserts into ${table} outside its owner — submit through ${PIPELINE} (submitTrade)`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && node.propertyName && tracked.has(node.propertyName.text)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && tracked.has(node.propertyName.text)
      && ts.isIdentifier(node.name)) {
      alias.set(node.name.text, node.propertyName.text);
    }
    if (ts.isIdentifier(node)) checkEntryName(node, node.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      checkEntryName(node, node.argumentExpression.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["insert", "update", "delete"].includes(node.expression.name.text)) {
      const table = tableOf(node.arguments[0]);
      if (table) checkWrite(node, node.expression.name.text, table);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const m = RAW_WRITE.exec(node.text);
      if (m) {
        const op = m[1]!.toLowerCase().startsWith("insert") ? "insert" : m[1]!.toLowerCase().startsWith("delete") ? "delete" : "update";
        const isSql = op !== "update" || /\bset\b/i.test(node.text) || !ts.isStringLiteral(node);
        if (isSql) checkWrite(node, `raw SQL ${op}`, PHYSICAL[m[2]!.toLowerCase()]!);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...out];
}

/** Structural proofs on the pipeline, the PAPER venue and the mailbox exception. */
export function checkPipelineShape(read: (key: string) => string | null): string[] {
  const v: string[] = [];
  const pipe = read(PIPELINE);
  if (pipe == null) return [`${PIPELINE} missing`];
  if (!/export\s+async\s+function\s+submitTrade\s*\(/.test(pipe)) v.push(`${PIPELINE}: submitTrade export missing`);
  for (const m of ["LIVE", "DEMO", "PAPER"]) {
    if (!new RegExp(`["']${m}["']`).test(pipe)) v.push(`${PIPELINE}: mode ${m} is not dispatched`);
  }
  for (const call of ["createDraftCommand", "createLiveDraft", "confirmLiveCommand", "dispatchLiveCommand",
    "submitGovernedClose", "submitGovernedModify", "openPaperOrder", "modifyPaperOrder", "closePaperOrder"]) {
    if (!new RegExp(`\\b${call}\\s*\\(`).test(pipe)) v.push(`${PIPELINE}: no longer delegates to ${call}`);
  }
  if (/\.(insert|update|delete)\s*\(\s*\w+Table\b/.test(pipe) || /@workspace\/db/.test(pipe.replace(/import\s+type[^;]*;/g, ""))) {
    v.push(`${PIPELINE}: the pipeline dispatches; it must not write tables itself`);
  }
  const paper = read(PAPER_VENUE);
  if (paper == null) v.push(`${PAPER_VENUE} missing`);
  else {
    const n = (paper.match(/\benforcePreTradeRisk\s*\(/g) ?? []).length;
    if (n < 3) v.push(`${PAPER_VENUE}: the Risk Governor must gate open, modify and close (found ${n} call(s))`);
    for (const a of ["OPEN", "MODIFY", "CLOSE"]) {
      if (!new RegExp(`venue:\\s*"PAPER",\\s*origin:\\s*"manual",\\s*action:\\s*"${a}"`).test(paper)) {
        v.push(`${PAPER_VENUE}: ${a} is not governed with venue PAPER`);
      }
    }
  }
  const me = read(MAILBOX_EXCEPTION);
  if (me != null) {
    const inserts = me.match(/\.insert\(\s*mt5CommandsTable\s*\)\.values\(\{[\s\S]{0,1200}?\}\)/g) ?? [];
    if (inserts.length !== 1 || !/action:\s*"CLOSE"/.test(inserts[0]!)) {
      v.push(`artifacts/api-server/src/${MAILBOX_EXCEPTION}: the mailbox exception is ONE risk-reducing CLOSE insert (found ${inserts.length})`);
    }
    const gate = me.indexOf('venue: "DEMO", origin: "manual", action: "CLOSE"');
    const ins = me.indexOf(".insert(mt5CommandsTable)");
    if (gate < 0 || ins < 0 || gate > ins) {
      v.push(`artifacts/api-server/src/${MAILBOX_EXCEPTION}: the DEMO close must be Risk Governor-checked before the mailbox insert`);
    }
  }
  return v;
}

export function checkTradeEngineSinglePipeline(): CheckResult {
  const violations: string[] = [];
  const seenEntry = new Set<string>();
  const seenPaper = new Set<string>();
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue; // operator one-offs and QA seeds
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const v of scanFile(key, src)) violations.push(`${rel(file)}:${v}`);
    const stripped = ts.createSourceFile(key, src, ts.ScriptTarget.Latest, true);
    const ids = new Set<string>();
    const collect = (n: ts.Node): void => { if (ts.isIdentifier(n)) ids.add(n.text); ts.forEachChild(n, collect); };
    collect(stripped);
    if (ENTRY_PRODUCERS[key] && [...ids].some((i) => ENTRY_OF.has(i))) seenEntry.add(key);
    if (PAPER_WRITERS[key] && PAPER_TABLES.some((t) => ids.has(t))) seenPaper.add(key);
  }
  for (const key of Object.keys(ENTRY_PRODUCERS)) {
    if (!seenEntry.has(key)) violations.push(`stale ENTRY_PRODUCERS entry: ${key} no longer calls a venue entry point — remove it`);
  }
  for (const key of Object.keys(PAPER_WRITERS)) {
    if (!seenPaper.has(key)) violations.push(`stale PAPER_WRITERS entry: ${key} no longer touches a paper book — remove it`);
  }
  const readKey = (k: string) => (existsSync(join(API_SRC, k)) ? readFileSync(join(API_SRC, k), "utf8") : null);
  violations.push(...checkPipelineShape(readKey));
  return {
    name: "trade-engine-single-pipeline",
    ok: violations.length === 0,
    violations,
    notes: [
      `${scanned} runtime files scanned; one pipeline (${PIPELINE}) with modes LIVE/DEMO/PAPER; ` +
        `${Object.keys(ENTRY_PRODUCERS).length} listed venue producers, ${Object.keys(PAPER_WRITERS).length} listed paper writers, ` +
        `1 mailbox trade exception (${MAILBOX_EXCEPTION} DEMO close)`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkTradeEngineSinglePipeline();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
