// AI chat server sweep 2026-11-04 (AICS-1 .. AICS-10) — regression suite.
// Offline: the ledger, the Risk Governor, routing, limits and the assistant
// name are mocked, so no DB round-trip is reached.
// Run with --experimental-test-module-mocks (test:ai-truth-complete-20261104).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── mocks (before importing tools.ts) ───────────────────────────────────────
type Basis = { source: string; sourceNote: string; currentAccountMode: string };
let basis: Basis = { source: "live_trades", sourceNote: "From your closed live trades recorded against your account.", currentAccountMode: "LIVE_SHARED" };
let ledgerRows: Array<Record<string, unknown>> = [];
const realLedger = await import("../../performanceCC/closedTradeLedger.js");
mock.module("../../performanceCC/closedTradeLedger.js", { namedExports: {
  ...realLedger,
  resolveLedgerBasis: async () => basis,
  resolveClosedTradeLedger: async () => ({ ...basis, rows: basis.source === "withheld_live_shared" ? [] : ledgerRows }),
} });

let governorCalls: Array<{ intent: Record<string, unknown>; opts: Record<string, unknown> }> = [];
let governorResult: Record<string, unknown> | Error = {};
const realEnforce = await import("../../riskGovernor/enforce.js");
mock.module("../../riskGovernor/enforce.js", { namedExports: {
  ...realEnforce,
  enforcePreTradeRisk: async (intent: Record<string, unknown>, opts: Record<string, unknown>) => {
    governorCalls.push({ intent, opts });
    if (governorResult instanceof Error) throw governorResult;
    return governorResult;
  },
} });

let envTradingMode = "LIVE";
const realSafety = await import("../../adminTrading/safetyEnvelope.js");
mock.module("../../adminTrading/safetyEnvelope.js", { namedExports: {
  ...realSafety, getEnvelope: async () => ({ tradingMode: envTradingMode }),
} });
const realRouting = await import("../../adminTrading/routingResolver.js");
mock.module("../../adminTrading/routingResolver.js", { namedExports: {
  ...realRouting,
  resolveRouting: async () => ({ ok: true, connectionId: 11, virtualAccountId: 22, blockReason: null }),
} });
let traderRow: Record<string, unknown> | null = null;
const realLimits = await import("../../riskGovernor/limitSettings.js");
mock.module("../../riskGovernor/limitSettings.js", { namedExports: {
  ...realLimits,
  readTraderRiskSettings: async () => traderRow,
  loadEffectiveLimits: async () => ({
    maxLotSize: 1, maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDailyLossPercent: 3,
    maxDailyLossAmount: null, requireStopLoss: true, maxPortfolioRiskPercent: 10, maxLeverage: 30,
    maxSymbolLeverage: 15, maxPositionsPerSymbol: 2, maxQuoteAgeMs: 60000, duplicateWindowMs: 60000,
    maxDrawdownPercent: null, symbolLimits: {}, allowedSymbols: ["EURUSD"], allowedDirection: null,
    liveAllowed: false, discipline: {}, sources: { maxLotSize: "admin", allowedSymbols: "admin" },
  }),
} });
const realName = await import("../assistantName.js");
mock.module("../assistantName.js", { namedExports: { ...realName, getAssistantDisplayName: async () => "Eleanor" } });

const { parseTradeCommand } = await import("../parseTradeCommand.js");
const { parseEntryProtection } = await import("../eleanorWatchEvaluator.js");
const { resolveAssistantToolChoice } = await import("../chartReadRouting.js");
const tools = await import("../tools.js");
const { buildArxAssistantSystemPrompt, buildSessionSystemMessages } = await import("../systemPrompt.js");
const { VOICE_NO_TOOLS_INSTRUCTION } = await import("../realtimeSession.js");
const { FAIL_CLOSED_ENVELOPE } = await import("../derivedEnvelope.js");

const here = fileURLToPath(new URL(".", import.meta.url));
const routeSrc = readFileSync(`${here}../../../routes/meAssistant.ts`, "utf8");
const loopSrc = readFileSync(`${here}../chatTurnLoop.ts`, "utf8");

// ── AICS-1: SL/TP on open commands ─────────────────────────────────────────
test("AICS-1: 'buy EURUSD 0.01 sl 1.0850 tp 1.0950' is an OPEN carrying both levels", () => {
  assert.deepEqual(parseTradeCommand("buy EURUSD 0.01 sl 1.0850 tp 1.0950"), {
    kind: "OPEN", side: "BUY", symbol: "EURUSD", volume: 0.01, orderType: "MARKET_BUY",
    stopLoss: 1.085, takeProfit: 1.095,
  });
});

test("AICS-1: 'buy EURUSD 0.01 sl at 1.0850' is an OPEN with SL, never a watch at the stop price", () => {
  const p = parseTradeCommand("buy EURUSD 0.01 sl at 1.0850");
  assert.equal(p.kind, "OPEN");
  assert.equal((p as { stopLoss?: number }).stopLoss, 1.085);
  assert.equal((p as { volume?: number }).volume, 0.01);
  assert.equal((p as { takeProfit?: number }).takeProfit, undefined);
});

test("AICS-1: 'sell gold 0.1 with SL above 2400' is an OPEN with SL (not WATCH_AND_ENTER above 2400)", () => {
  const p = parseTradeCommand("sell gold 0.1 with SL above 2400");
  assert.equal(p.kind, "OPEN");
  assert.equal((p as { symbol?: string }).symbol, "XAUUSD");
  assert.equal((p as { side?: string }).side, "SELL");
  assert.equal((p as { volume?: number }).volume, 0.1);
  assert.equal((p as { stopLoss?: number }).stopLoss, 2400);
});

test("AICS-1: 'tp at X' / 'take profit at X' / 'stop loss: X' never arm a watch", () => {
  for (const t of ["buy EURUSD 0.02 tp at 1.0950", "buy EURUSD 0.02 take profit at 1.0950 stop loss: 1.08"]) {
    const p = parseTradeCommand(t);
    assert.equal(p.kind, "OPEN", t);
    assert.equal((p as { takeProfit?: number }).takeProfit, 1.095, t);
    assert.equal((p as { volume?: number }).volume, 0.02, t);
  }
});

test("AICS-1: an SL price is never read as the lot size (default volume used)", () => {
  const p = parseTradeCommand("buy EURUSD sl 1.0850", { defaultVolume: 0.05 });
  assert.equal(p.kind, "OPEN");
  assert.equal((p as { volume?: number }).volume, 0.05);
  assert.equal((p as { stopLoss?: number }).stopLoss, 1.085);
  assert.equal(parseTradeCommand("buy EURUSD sl 1.0850").kind, "MISSING_VOLUME");
});

test("AICS-1: a real trigger with SL/TP stays a WATCH_AND_ENTER that carries the protection", () => {
  const p = parseTradeCommand("buy EURUSD 0.01 lots when it hits 1.0900 sl 1.0850 tp 1.0990");
  assert.equal(p.kind, "WATCH_AND_ENTER");
  const w = p as { trigger: { price: number }; stopLoss?: number; takeProfit?: number; volume?: number };
  assert.equal(w.trigger.price, 1.09);
  assert.equal(w.stopLoss, 1.085);
  assert.equal(w.takeProfit, 1.099);
  assert.equal(w.volume, 0.01);
});

test("AICS-1: an SL/TP in pips asks for a price level instead of opening unprotected", () => {
  assert.deepEqual(parseTradeCommand("buy EURUSD 0.01 sl 20 pips"), { kind: "SLTP_NEEDS_PRICE", side: "BUY", symbol: "EURUSD" });
});

test("AICS-1: plain commands and MODIFY are unchanged", () => {
  assert.deepEqual(parseTradeCommand("buy EURUSD 0.01"), { kind: "OPEN", side: "BUY", symbol: "EURUSD", volume: 0.01, orderType: "MARKET_BUY" });
  const m = parseTradeCommand("set SL to 1.0850");
  assert.equal(m.kind, "MODIFY");
  assert.equal((m as { newStopLoss?: number }).newStopLoss, 1.085);
  assert.equal(parseTradeCommand("sell XAUUSD at 1850").kind, "WATCH_AND_ENTER");
});

test("AICS-1: the route passes SL/TP into the OPEN intent and the watch row; the evaluator reads them back", () => {
  assert.match(routeSrc, /parsed\.stopLoss !== undefined \? \{ stopLoss: parsed\.stopLoss \}/);
  assert.match(routeSrc, /riskParams: parsed\.kind === "WATCH_AND_ENTER"/);
  assert.deepEqual(parseEntryProtection(JSON.stringify({ stopLoss: 1.085, takeProfit: 1.099 })), { stopLoss: 1.085, takeProfit: 1.099 });
  assert.deepEqual(parseEntryProtection(null), {});
  assert.deepEqual(parseEntryProtection("{bad"), {});
  assert.deepEqual(parseEntryProtection(JSON.stringify({ alertsSinceAck: 2 })), {});
});

// ── AICS-2: performance tools read the Performance Calendar's book ─────────
test("AICS-2: live user — daily P&L and journal summary come from the live book and say so", async () => {
  basis = { source: "live_trades", sourceNote: "From your closed live trades recorded against your account.", currentAccountMode: "PAPER" };
  const now = new Date();
  ledgerRows = [
    { id: 1, symbol: "EURUSD", side: "BUY", pnl: 12.5, closedAt: now, strategyTag: null },
    { id: 2, symbol: "EURUSD", side: "SELL", pnl: -2.5, closedAt: now, strategyTag: null },
  ];
  const cal = await tools.getDailyPnLCalendar(7, 30) as Record<string, unknown>;
  assert.equal(cal.source, "live_trades");
  const days = cal.days as Array<{ totalPnl: number; tradesCount: number }>;
  assert.equal(days.length, 1);
  assert.equal(days[0]!.totalPnl, 10);
  assert.equal(days[0]!.tradesCount, 2);
  const j = await tools.getTradeJournalSummary(7, 30) as Record<string, unknown>;
  assert.equal(j.source, "live_trades");
  assert.equal(j.totalClosed, 2);
});

test("AICS-2: LIVE_SHARED user — performance and calendar are withheld, never paper numbers", async () => {
  basis = { source: "withheld_live_shared", sourceNote: realLedger.WITHHELD_LIVE_SHARED_NOTE, currentAccountMode: "LIVE_SHARED" };
  ledgerRows = [{ id: 9, symbol: "EURUSD", side: "BUY", pnl: 99, closedAt: new Date(), strategyTag: null }];
  const perf = await tools.getMyPerformanceSummary(7, 30) as Record<string, unknown>;
  assert.equal(perf.isEmpty, true);
  assert.equal(perf.source, "withheld_live_shared");
  assert.doesNotMatch(String(perf.emptyMessage), /paper trade/i);
  const cal = await tools.getDailyPnLCalendar(7, 30) as Record<string, unknown>;
  assert.deepEqual(cal.days, []);
  const acct = await tools.getAccountSnapshot(7) as Record<string, unknown>;
  assert.equal(acct.source, "withheld_live_shared");
  assert.equal(acct.totalPnl, null);
});

test("AICS-2: tool descriptions and the prompt route by `source`", () => {
  for (const name of ["getAccountSnapshot", "getTradeJournalSummary", "getDailyPnLCalendar", "getMyPerformanceSummary"]) {
    const d = tools.TOOL_DEFINITIONS.find((t) => t.name === name)!;
    assert.match(d.description, /SAME book as the Performance Calendar/, name);
  }
  assert.match(buildArxAssistantSystemPrompt("Eleanor"), /withheld_live_shared/);
});

// ── AICS-3: pre-trade check runs the real governor preview ─────────────────
test("AICS-3: runPreTradeRiskCheck runs the governor in preview mode on the account's venue and routing", async () => {
  envTradingMode = "LIVE"; governorCalls = [];
  governorResult = {
    decision: "BLOCK", allowed: false, blockedBy: ["max_position_size"], primaryReason: "Lot 2 is above the 1.00 limit.",
    rules: [{ rule: "max_position_size", outcome: "BLOCK", reason: "Lot 2 is above the 1.00 limit." }, { rule: "leverage", outcome: "PASS", reason: null }],
    evaluatedAt: new Date().toISOString(), auditEventId: null, limits: null,
  };
  const r = await tools.runPreTradeRiskCheck(7, { symbol: "eurusd", side: "buy", size: 2, stopLoss: 1.08 }, FAIL_CLOSED_ENVELOPE) as Record<string, unknown>;
  assert.equal(governorCalls.length, 1);
  assert.equal(governorCalls[0]!.opts.preview, true);
  assert.equal(governorCalls[0]!.opts.connectionId, 11);
  assert.equal(governorCalls[0]!.opts.virtualAccountId, 22);
  assert.equal(governorCalls[0]!.intent.venue, "LIVE");
  assert.equal(governorCalls[0]!.intent.symbol, "EURUSD");
  assert.equal(governorCalls[0]!.intent.side, "BUY");
  assert.equal(r.wouldPass, false);
  assert.equal(r.limitsEvaluated, true);
  assert.deepEqual(r.blockingReasons, ["max_position_size"]);
  assert.equal((r.blockedRules as unknown[]).length, 1);
});

test("AICS-3: when the governor cannot run, wouldPass is null and the limits are reported as not evaluated", async () => {
  envTradingMode = "SIMULATED"; governorCalls = [];
  governorResult = new Error("db down");
  const r = await tools.runPreTradeRiskCheck(7, { symbol: "EURUSD", side: "sell", size: 0.1 }, FAIL_CLOSED_ENVELOPE) as Record<string, unknown>;
  assert.equal(r.wouldPass, null);
  assert.equal(r.limitsEvaluated, false);
  assert.match(String(r.note), /no limits were evaluated/);
  assert.equal(governorCalls[0]!.intent.venue, "PAPER");
});

test("AICS-3: getRiskLimits includes the limits in force (operator + platform) even with no trader row", async () => {
  traderRow = null;
  const r = await tools.getRiskLimits(7) as Record<string, unknown>;
  assert.equal(r.hasRiskSettings, false);
  const eff = r.effectiveLimits as Record<string, unknown>;
  assert.equal(eff.maxLotSize, 1);
  assert.deepEqual(eff.allowedSymbols, ["EURUSD"]);
  assert.equal(eff.liveAllowed, false);
  assert.equal((r.effectiveLimitSources as Record<string, string>).maxLotSize, "admin");
  assert.equal(tools.preTradeVenueFor("DEMO").venue, "DEMO");
  assert.equal(tools.preTradeVenueFor("DISABLED").venue, "PAPER");
});

// ── AICS-4: last turn must answer in text ──────────────────────────────────
test("AICS-4: the final turn forces tool_choice none and the route reports an empty reply", () => {
  assert.equal(resolveAssistantToolChoice(0, false, 4), "auto");
  assert.deepEqual(resolveAssistantToolChoice(0, true, 4), { type: "function", function: { name: "readChartStructure" } });
  assert.equal(resolveAssistantToolChoice(2, false, 4), "auto");
  assert.equal(resolveAssistantToolChoice(3, false, 4), "none");
  assert.equal(resolveAssistantToolChoice(3, true), "auto", "back-compat without maxTurns");
  // The loop moved to chatTurnLoop.ts (shared with the eval harness); the route passes the cap.
  assert.match(loopSrc, /resolveAssistantToolChoice\(turn, input\.forceStructuralRead, input\.maxTurns\)/);
  assert.match(routeSrc, /maxTurns: MAX_TURNS_PER_REQUEST,\s*forceStructuralRead,/);
  assert.match(routeSrc, /assistantText\.trim\(\)\.length === 0\) \{\s*send\(\{ type: "error", message: EMPTY_REPLY_MESSAGE \}\)/);
});

// ── AICS-5: push-to-talk voice says it has no tools ────────────────────────
test("AICS-5: the gpt-audio voice route appends the same no-tools instruction as the realtime path", () => {
  assert.match(VOICE_NO_TOOLS_INSTRUCTION, /Voice mode has NO tools/);
  assert.match(routeSrc, /\{ role: "system", content: `\$\{VOICE_NO_TOOLS_INSTRUCTION\}/);
});

// ── AICS-6 / AICS-7: prompt names real tools and honest ticket wording ────
test("AICS-6/7: prompt sends feed questions to getMarketDataProviderStatus and calls prepare*Ticket previews", () => {
  const p = buildArxAssistantSystemPrompt("Eleanor");
  assert.doesNotMatch(p, /read getMarketStatus/);
  assert.match(p, /call getMarketDataProviderStatus and\s+answer from its dataFreshness/);
  assert.doesNotMatch(p, /prepareOpenTicket \/ prepareCloseTicket \/ createTradeActionDraft for the Trade Action Center/);
  assert.match(p, /prepareOpenTicket \/ prepareCloseTicket are PREVIEWS ONLY/);
});

// ── AICS-9: no permanently-unavailable current-events tool ─────────────────
test("AICS-9: getCurrentEvents is not advertised and the prompt says current events are unavailable", () => {
  const names = tools.TOOL_DEFINITIONS.map((t) => t.name as string);
  assert.ok(!names.includes("getCurrentEvents"));
  for (const t of tools.TOOL_DEFINITIONS) assert.doesNotMatch(t.description, /call getCurrentEvents/);
  const p = buildSessionSystemMessages(1, null, null, FAIL_CLOSED_ENVELOPE, "Eleanor").map((m) => m.content).join("\n");
  assert.doesNotMatch(p, /call getCurrentEvents/);
  assert.match(p, /current events \/ real-world news are not available in ARX right now/);
});

// ── AICS-10: one envelope per request ──────────────────────────────────────
test("AICS-10: the chat route derives the envelope once and passes it to every tool call", () => {
  assert.match(routeSrc, /dispatchTool\(name, parsedArgs, userId, req, safetyEnvelope\)/);
  assert.match(routeSrc, /const envelope = assistantEnvelopeFields\(safetyEnvelope\)/);
});

// ── Coordinator item 3: no "paper trading" copy in the performance routing ──
test("copy: the performance empty-state and routing say demo trades, not paper trading", () => {
  const p = buildArxAssistantSystemPrompt("Eleanor");
  assert.doesNotMatch(p, /Place a paper trade/);
  assert.match(p, /Log a demo trade on My Demo Trades/);
  const d = tools.TOOL_DEFINITIONS.find((t) => t.name === "getOpenPositions")!;
  assert.doesNotMatch(d.description, /paper trades/);
});
