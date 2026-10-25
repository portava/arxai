// ── Trade Engine: one pipeline, LIVE / DEMO / PAPER are modes of it ──────
//
// lib/tradeEngine/pipeline.ts (submitTrade) is the one entry for opening,
// closing and modifying a trade in any mode; its staged contract
// (draftTrade / confirmTrade / dispatchTrade) serves LIVE/DEMO flows that
// draft now and confirm or dispatch later; submitInstantTrade is its
// one-click LIVE channel and fillPaperTrade / settlePaperTrade /
// voidPaperTrade its caller-priced PAPER fills. It delegates to the governed
// path that already exists for each mode and adds/removes no gate:
//
//   LIVE  → liveCommandPipeline (Phase B, the only live writer)
//   LIVE one-click → lib/live/instantTrade executeInstant (its own gates,
//           then Phase B through the staged contract)
//   DEMO  → demoCommandQueue (draft → confirm → dispatch)
//   LIVE/DEMO close & modify → lib/positions/governedOps
//   PAPER → lib/tradeEngine/paperVenue (paper simulator book, including the
//           caller-priced fills and venue settlement)
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
// The listed producers are the pipeline and its own internal legs. The
// one-click router (executeInstant) and the caller-priced PAPER fills are
// PIPELINE_ONLY: no file but the pipeline may call them, and no allowlist
// entry may grant them to another file. A new direct caller fails until it
// goes through submitTrade / the staged contract / submitInstantTrade /
// fillPaperTrade. executeInstant itself reaches the live queue only through
// the pipeline's staged contract (checked below).
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

type Entry = "DEMO_QUEUE" | "LIVE_PIPELINE" | "LIVE_INSTANT" | "GOVERNED_OPS" | "PAPER_VENUE" | "PAPER_FILL" | "LEGACY_DEMO_CLOSE";

/** Venue entry points: calling one creates or changes exposure on that venue. */
export const ENTRY_POINTS: Record<Entry, { names: string[]; owner: string }> = {
  LEGACY_DEMO_CLOSE: { names: ["queueLegacyDemoClose"], owner: "lib/tradeEngine/legacyDemoClose.ts" },
  DEMO_QUEUE: { names: ["createDraftCommand", "confirmCommand", "dispatchApprovedCommand"], owner: "lib/mt5/demoCommandQueue.ts" },
  LIVE_PIPELINE: { names: ["createLiveDraft", "createLiveOpsDraft", "confirmLiveCommand", "dispatchLiveCommand"], owner: "lib/live/liveCommandPipeline.ts" },
  LIVE_INSTANT: { names: ["executeInstant"], owner: "lib/live/instantTrade.ts" },
  GOVERNED_OPS: { names: ["submitGovernedClose", "submitGovernedModify"], owner: "lib/positions/governedOps.ts" },
  PAPER_VENUE: { names: ["openPaperOrder", "modifyPaperOrder", "closePaperOrder"], owner: PAPER_VENUE },
  // Caller-priced paper fills and venue settlement (one paper book; see check-single-paper-book).
  PAPER_FILL: { names: ["openPaperFill", "closePaperFill", "settlePaperOrder", "voidPaperOrder"], owner: PAPER_VENUE },
};
const ENTRY_OF = new Map<string, Entry>(
  (Object.entries(ENTRY_POINTS) as [Entry, { names: string[] }][]).flatMap(([k, v]) => v.names.map((n) => [n, k] as const)),
);

/** Files allowed to call venue entry points directly, and why. */
export const ENTRY_PRODUCERS: Record<string, { entries: Entry[]; why: string }> = {
  [PIPELINE]: {
    entries: ["DEMO_QUEUE", "LIVE_PIPELINE", "LIVE_INSTANT", "GOVERNED_OPS", "PAPER_VENUE", "PAPER_FILL", "LEGACY_DEMO_CLOSE"],
    why: "the one pipeline (submitTrade, the staged contract, submitInstantTrade, fillPaperTrade / settlePaperTrade / voidPaperTrade)",
  },
  "lib/positions/governedOps.ts": { entries: ["DEMO_QUEUE", "LIVE_PIPELINE"], why: "the LIVE/DEMO position-op leg of the pipeline" },
  // lib/live/instantTrade.ts, the one-click leg, owns LIVE_INSTANT and reaches
  // Phase B only through the staged contract (checked below), so it needs no
  // entry here. Missions, self-trade agents, the one-click route, the
  // assistant and the Position Guardian exit door call submitInstantTrade;
  // Build EE and the QA fixture call fillPaperTrade / settlePaperTrade /
  // voidPaperTrade; the exit door's stop restore is a submitTrade MODIFY.
};

/**
 * Entries only the pipeline may call: the one-click router (executeInstant,
 * reached through submitInstantTrade) and the caller-priced PAPER fills
 * (reached through fillPaperTrade / settlePaperTrade / voidPaperTrade).
 */
export const PIPELINE_ONLY_ENTRIES: readonly Entry[] = ["LIVE_INSTANT", "PAPER_FILL", "LEGACY_DEMO_CLOSE"];
/** The pipeline's public channel for each pipeline-only venue call: export name → venue calls it delegates to. */
export const PIPELINE_CHANNELS: Record<string, string[]> = {
  submitInstantTrade: ["executeInstant"],
  fillPaperTrade: ["openPaperFill", "closePaperFill"],
  settlePaperTrade: ["settlePaperOrder"],
  voidPaperTrade: ["voidPaperOrder"],
  closeLegacyDemoTrade: ["queueLegacyDemoClose"],
};

/** Allowlist sanity: no file but the pipeline may be granted a pipeline-only entry. */
export function checkProducerList(list: Record<string, { entries: Entry[] }> = ENTRY_PRODUCERS): string[] {
  const out: string[] = [];
  for (const [key, p] of Object.entries(list)) {
    if (key === PIPELINE) continue;
    for (const e of p.entries) {
      if (PIPELINE_ONLY_ENTRIES.includes(e)) out.push(`ENTRY_PRODUCERS: ${key} lists ${e}, which only ${PIPELINE} may call`);
    }
  }
  return out;
}

/** The one-click live entry: it reaches Phase B only through the staged contract. */
export const INSTANT_ENTRY = "lib/live/instantTrade.ts";
/** Staged steps executeInstant must take (open, close and modify), as "fn:MODE[:KIND]". */
export const INSTANT_STAGED_CALLS = ["draftTrade:LIVE:ENTRY", "draftTrade:LIVE:OPS", "confirmTrade:LIVE", "dispatchTrade:LIVE"];
const STAGED_FNS = ["draftTrade", "confirmTrade", "dispatchTrade"];

/** Paper / legacy trade books. */
export const PAPER_TABLES = ["paperOrdersTable", "paperTradesTable", "tradesTable"] as const;
/** Command tables: their owners insert; lifecycle updates are check-execution-single-entry's job. */
export const COMMAND_TABLES: Record<string, string[]> = {
  arxLiveCommandsTable: ["lib/live/liveCommandPipeline.ts"],
  mt5DemoCommandsTable: ["lib/mt5/demoCommandQueue.ts"],
  mt5CommandsTable: [
    "lib/live/liveCommandPipeline.ts", // Phase B's EA bridge mirror
    "lib/tradeEngine/legacyDemoClose.ts", // internal legacy close transport
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
export const MAILBOX_EXCEPTION = "lib/tradeEngine/legacyDemoClose.ts";

/** Files allowed to write paper / legacy trade books, and why. */
export const PAPER_WRITERS: Record<string, { tables: (typeof PAPER_TABLES)[number][]; why: string }> = {
  [PAPER_VENUE]: { tables: ["paperOrdersTable"], why: "the one paper book: PAPER mode of the pipeline and the Build EE / QA fixture fills (Risk Governor on open/modify/close; SL/TP hits are venue fills)" },
  "routes/mePaperTrades.ts": { tables: ["paperTradesTable"], why: "paper trade journal (governed open and stop/target edits)" },
  "lib/trades/paperBook.ts": { tables: ["tradesTable"], why: "legacy simulated-trade book, closed to new rows since /execute-trade was retired (owner decision 14): emergency-stop cancel and Position Guardian management (applyPaperManagement, exit door only)" },
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
    if (PIPELINE_ONLY_ENTRIES.includes(entry) && key !== PIPELINE) {
      const via = Object.entries(PIPELINE_CHANNELS).find(([, calls]) => calls.includes(name))?.[0] ?? "submitTrade";
      fail(node, `calls ${name} (${entry}) directly — only ${PIPELINE} may; use its ${via}`);
      return;
    }
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
  for (const fn of ["draftTrade", "confirmTrade", "dispatchTrade"]) {
    if (!new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`).test(pipe)) v.push(`${PIPELINE}: staged ${fn} export missing`);
  }
  for (const fn of Object.keys(PIPELINE_CHANNELS)) {
    if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(pipe)) v.push(`${PIPELINE}: ${fn} export missing`);
  }
  for (const call of ["createDraftCommand", "confirmCommand", "dispatchApprovedCommand",
    "createLiveDraft", "createLiveOpsDraft", "confirmLiveCommand", "dispatchLiveCommand",
    "submitGovernedClose", "submitGovernedModify", "openPaperOrder", "modifyPaperOrder", "closePaperOrder",
    ...Object.values(PIPELINE_CHANNELS).flat()]) {
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
      // The origin is the caller's (manual, ruby, automation); the venue and action are pinned.
      if (!new RegExp(`venue:\\s*"PAPER",\\s*origin:\\s*[^,]+,\\s*action:\\s*"${a}"`).test(paper)) {
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
  const instant = read(INSTANT_ENTRY);
  if (instant == null) v.push(`artifacts/api-server/src/${INSTANT_ENTRY} missing`);
  else {
    const calls = stagedCalls(instant);
    for (const c of INSTANT_STAGED_CALLS) {
      if (!calls.has(c)) v.push(`artifacts/api-server/src/${INSTANT_ENTRY}: executeInstant must reach Phase B through the pipeline (${c} not found)`);
    }
  }
  return v;
}

/**
 * Staged pipeline calls in a source file, as "fn:MODE" or "fn:MODE:KIND"
 * (e.g. "draftTrade:LIVE:OPS"), read from the call's literal stage object.
 */
export function stagedCalls(source: string): Set<string> {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const lit = (o: ts.ObjectLiteralExpression, name: string): string | null => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name && ts.isStringLiteralLike(p.initializer)) {
        return p.initializer.text;
      }
    }
    return null;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && STAGED_FNS.includes(n.expression.text)) {
      const stage = n.arguments[0];
      const mode = stage && ts.isObjectLiteralExpression(stage) ? lit(stage, "mode") : null;
      if (stage && mode && ts.isObjectLiteralExpression(stage)) {
        const kind = lit(stage, "kind");
        out.add([n.expression.text, mode, ...(kind ? [kind] : [])].join(":"));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
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
  violations.push(...checkProducerList());
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
        `1 internal legacy DEMO close transport (${MAILBOX_EXCEPTION}); no route trade writer`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkTradeEngineSinglePipeline();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
