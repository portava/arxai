// Build FF — Paper Autopilot Service.
//
// SAFETY (strict freeze):
//   - PAPER_ONLY mode enforced via assertSafe() before every cycle.
//   - NEVER calls executeTrade / mt5_* / setCanPlaceTrades / live broker.
//   - Delegates all execution to Build EE (paper-only).
//   - All AA evaluations go through the existing orchestrator.
//   - All market data comes from Build DD (read-only).
//   - BB auto-debrief and CC learning fire automatically inside EE close path.

import { randomUUID } from "node:crypto";
import { db,
  autopilotSettingsTable,
  autopilotCyclesTable,
  autopilotCycleLogsTable,
  autopilotSymbolCooldownsTable,
  paperOrdersTable,
  paperExecutionsTable,
  postTradeDebriefsTable,
  learningEventsTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { loadSettings, assertSafe } from "./settings.js";
import { runSniperFilter } from "./sniperFilter.js";
import { orchestrate, persistDecision } from "../../routes/tradeDecision.js";
import { executePaperFromDecision, getPaperExecutionByDecisionId } from "../paperExecution/paperExecutionService.js";
import { runPaperMonitor } from "../paperExecution/paperExecutionMonitor.js";
import { gateForAutopilot } from "../riskGovernor/governor.js";
import type { AutopilotSettings, AutopilotCycleSummary, SniperResult } from "./types.js";
import type { TradeDecision } from "../../routes/tradeDecision.js";

async function logCycle(args: {
  cycleId: string;
  symbol?: string | null;
  timeframe?: string | null;
  step: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(autopilotCycleLogsTable).values({
      autopilotCycleId: args.cycleId,
      symbol: args.symbol ?? null,
      timeframe: args.timeframe ?? null,
      step: args.step,
      status: args.status,
      message: args.message,
      details: args.details ?? {},
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "FF: cycle log insert failed (non-fatal)");
  }
}

async function getActiveCooldown(symbol: string): Promise<{ active: boolean; reason: string | null; until: string | null }> {
  const now = new Date();
  const rows = await db.select().from(autopilotSymbolCooldownsTable)
    .where(and(eq(autopilotSymbolCooldownsTable.symbol, symbol), gt(autopilotSymbolCooldownsTable.cooldownUntil, now)))
    .orderBy(desc(autopilotSymbolCooldownsTable.cooldownUntil)).limit(1);
  const r = rows[0];
  if (!r) return { active: false, reason: null, until: null };
  return { active: true, reason: r.reason, until: r.cooldownUntil.toISOString() };
}

async function applyCooldown(symbol: string, action: string, reason: string, minutes: number, refs: { tradeId?: number; decisionId?: number }) {
  const until = new Date(Date.now() + minutes * 60_000);
  await db.insert(autopilotSymbolCooldownsTable).values({
    symbol, action, reason, cooldownUntil: until,
    lastTradeId: refs.tradeId ?? null,
    lastDecisionId: refs.decisionId ?? null,
    updatedAt: new Date(),
  });
}

async function dailyPaperPnl(): Promise<number> {
  // Sum of profit_loss on EE-owned closed paper_orders since UTC midnight.
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const rows = await db.select({
    pnl: sql<number>`COALESCE(SUM(${paperOrdersTable.profitLoss}), 0)`,
  }).from(paperOrdersTable)
    .where(and(
      eq(paperOrdersTable.strategyId, "build_ee_paper_execution"),
      gte(paperOrdersTable.closedAt, since),
    ));
  return Number(rows[0]?.pnl ?? 0);
}

async function countOpen(): Promise<{ total: number; bySymbolDir: Map<string, number> }> {
  const rows = await db.select({
    symbol: paperOrdersTable.symbol, direction: paperOrdersTable.direction,
  }).from(paperOrdersTable)
    .where(and(eq(paperOrdersTable.strategyId, "build_ee_paper_execution"), eq(paperOrdersTable.status, "OPEN")));
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.symbol}|${r.direction}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return { total: rows.length, bySymbolDir: map };
}

export async function runOneCycle(opts?: { settingsOverride?: Partial<AutopilotSettings>; cycleIdOverride?: string }): Promise<AutopilotCycleSummary> {
  const cycleId = opts?.cycleIdOverride ?? `ffcyc_${randomUUID()}`;
  const startedAt = new Date();

  // 1. Load + assert safety.
  let settings = await loadSettings();
  if (opts?.settingsOverride) settings = { ...settings, ...opts.settingsOverride, mode: "PAPER_ONLY", paperOnly: true, liveTradingAllowed: false };
  assertSafe(settings);

  // Phase 22J: per-user scoping. The autopilot is currently a singleton — read
  // the owner's userId from the settings row so orchestrate() can evaluate
  // against that user's risk profile.
  const ownerRows = await db.select({ userId: autopilotSettingsTable.userId })
    .from(autopilotSettingsTable).orderBy(desc(autopilotSettingsTable.id)).limit(1);
  const ownerUserId = ownerRows[0]?.userId ?? null;

  const summary: AutopilotCycleSummary = {
    autopilot_cycle_id: cycleId,
    mode: "PAPER_ONLY",
    status: "RUNNING",
    started_at: startedAt.toISOString(),
    finished_at: null,
    symbols_checked: 0, decisions_created: 0,
    paper_trades_opened: 0, paper_trades_rejected: 0,
    paper_trades_monitored: 0, paper_trades_closed: 0,
    debriefs_triggered: 0, learning_events_triggered: 0,
    warnings: [], errors: [], per_symbol: [],
  };

  // If unowned (legacy row), abort rather than fall back to global state.
  if (ownerUserId == null) {
    summary.errors.push("Autopilot settings row has no user_id — refusing to run unscoped cycle (Phase 22J).");
    summary.finished_at = new Date().toISOString();
    return summary;
  }

  // 2. Insert cycle row.
  const cyc = await db.insert(autopilotCyclesTable).values({
    autopilotCycleId: cycleId, mode: "PAPER_ONLY", status: "RUNNING",
    startedAt,
  }).returning({ id: autopilotCyclesTable.id });
  const cycRowId = cyc[0]?.id ?? 0;

  // 2b. Build HH gate: Risk Governor must allow autopilot to run this cycle.
  try {
    // Scope the governor to the owner of this autopilot cycle (ownerUserId is
    // proven non-null a few lines above — an unowned settings row aborts).
    const gate = await gateForAutopilot(ownerUserId);
    if (!gate.allowed) {
      summary.warnings.push(`RISK_GOVERNOR_PAUSE[${gate.status}]: ${gate.reasons[0] ?? "blocked"}`);
      summary.status = "STOPPED";
      summary.finished_at = new Date().toISOString();
      await logCycle({ cycleId, step: "GOVERNOR_PAUSE", status: "WARN",
        message: `FF cycle paused by Risk Governor: ${gate.status}`,
        details: { governorId: gate.governorId, reasons: gate.reasons } });
      try {
        await db.update(autopilotCyclesTable)
          .set({ status: "STOPPED", finishedAt: new Date() })
          .where(eq(autopilotCyclesTable.id, cycRowId));
      } catch { /* non-fatal */ }
      return summary;
    }
  } catch (e) {
    logger.error({ err: String(e).slice(0, 200) }, "FF: governor gate threw — failing CLOSED (cycle stopped)");
    summary.warnings.push(`RISK_GOVERNOR_GATE_ERROR: ${String(e).slice(0, 160)}`);
    summary.status = "STOPPED";
    summary.finished_at = new Date().toISOString();
    await logCycle({ cycleId, step: "GOVERNOR_PAUSE", status: "ERROR",
      message: `FF cycle stopped: governor gate threw (fail-closed)`,
      details: { error: String(e).slice(0, 200) } });
    try {
      await db.update(autopilotCyclesTable)
        .set({ status: "STOPPED", finishedAt: new Date() })
        .where(eq(autopilotCyclesTable.id, cycRowId));
    } catch { /* non-fatal */ }
    return summary;
  }

  await logCycle({ cycleId, step: "CYCLE_START", status: "INFO",
    message: `FF cycle ${cycleId} started`, details: { settings } });
  await logCycle({ cycleId, step: "LOAD_SETTINGS", status: "OK",
    message: `Loaded settings: ${settings.symbols.length} symbol(s), interval ${settings.intervalSeconds}s`,
    details: { symbols: settings.symbols, timeframes: settings.timeframes } });

  try {
    // 3. Daily-loss safety check.
    const dpnl = await dailyPaperPnl();
    if (dpnl <= -Math.abs(settings.maxDailyPaperLoss)) {
      summary.warnings.push(`Daily paper loss limit hit (${dpnl.toFixed(2)} ≤ -${settings.maxDailyPaperLoss}) — no new trades`);
      await logCycle({ cycleId, step: "SAFETY_SHUTDOWN", status: "WARN",
        message: `Daily paper loss ${dpnl.toFixed(2)} ≤ -${settings.maxDailyPaperLoss} — refusing new trades`,
        details: { dailyPnl: dpnl, limit: settings.maxDailyPaperLoss } });
    }
    const allowNewTrades = dpnl > -Math.abs(settings.maxDailyPaperLoss);

    // 4. Per-symbol/timeframe loop.
    for (const symbol of settings.symbols) {
      for (const timeframe of settings.timeframes) {
        summary.symbols_checked += 1;
        const perSym: AutopilotCycleSummary["per_symbol"][number] = {
          symbol, timeframe, aaAction: "?", aaConfidence: 0, aaRiskScore: 0,
          sniper: { sniperEntryScore: 0, status: "REJECT", reasons: [], blockers: [], warnings: [], components: {} },
          eePaperResult: null, paperTradeId: null, decisionId: null, skippedReason: null,
        };

        try {
          // 4a. AA decision (also fetches DD internally).
          await logCycle({ cycleId, symbol, timeframe, step: "AA_DECISION", status: "INFO",
            message: `Calling Build AA orchestrator for ${symbol} ${timeframe}` });
          const decision: TradeDecision = await orchestrate({ symbol, proposedAction: "AUTO", injectMarketIssue: "NONE" }, ownerUserId);
          const decisionId = await persistDecision(decision);
          summary.decisions_created += 1;
          perSym.decisionId = decisionId;
          perSym.aaAction = decision.action;
          perSym.aaConfidence = decision.confidence;
          perSym.aaRiskScore = decision.riskScore;

          await logCycle({ cycleId, symbol, timeframe, step: "FETCH_MD", status: decision.marketDataSummary ? "OK" : "WARN",
            message: `DD market data: source=${decision.marketDataSummary?.source ?? "none"} quality=${decision.marketDataSummary?.dataQualityStatus ?? "n/a"}`,
            details: { mdSummary: decision.marketDataSummary ?? null } });
          await logCycle({ cycleId, symbol, timeframe, step: "AA_DECISION", status: decision.shouldTrade ? "OK" : "SKIP",
            message: `AA decision: ${decision.action} conf=${decision.confidence} risk=${decision.riskScore} window=${decision.tradeWindow.status}`,
            details: { decisionId, action: decision.action, confidence: decision.confidence, riskScore: decision.riskScore, blockers: decision.blockers } });

          // 4b. Hard skips.
          if (!allowNewTrades) {
            perSym.skippedReason = "DAILY_LOSS_LIMIT";
            summary.paper_trades_rejected += 1;
            await logCycle({ cycleId, symbol, timeframe, step: "SNIPER", status: "SKIP",
              message: "Skipped: daily paper loss limit", details: {} });
            summary.per_symbol.push(perSym);
            continue;
          }
          if (!decision.shouldTrade) {
            perSym.skippedReason = "AA_HOLD";
            summary.paper_trades_rejected += 1;
            await logCycle({ cycleId, symbol, timeframe, step: "EE_EXEC", status: "SKIP",
              message: `Skipped: AA returned HOLD (${decision.invalidationReason})`, details: {} });
            summary.per_symbol.push(perSym);
            continue;
          }

          // 4c. Cooldown + open caps.
          const cooldown = await getActiveCooldown(symbol);
          const openInfo = await countOpen();
          const sameSymDirOpen = openInfo.bySymbolDir.get(`${symbol}|${decision.action}`) ?? 0;

          // 4d. Sniper filter.
          const sniper: SniperResult = runSniperFilter({
            decision,
            minSniperEntryScore: settings.minSniperEntryScore,
            conflict: { sameSymbolDirOpen: sameSymDirOpen, totalOpen: openInfo.total, maxOpen: settings.maxOpenPaperTrades, maxSameSym: settings.maxSameSymbolTrades },
            cooldown,
            recentMistakeWarnings: decision.knownMistakeWarnings ?? [],
          });
          perSym.sniper = sniper;
          await logCycle({ cycleId, symbol, timeframe, step: "SNIPER", status: sniper.status === "PASS" ? "OK" : "SKIP",
            message: `Sniper ${sniper.status} score=${sniper.sniperEntryScore} (threshold ${settings.minSniperEntryScore})`,
            details: { sniper } });

          if (sniper.status !== "PASS") {
            perSym.skippedReason = `SNIPER_${sniper.status}`;
            summary.paper_trades_rejected += 1;
            summary.per_symbol.push(perSym);
            continue;
          }

          // 4e. EE paper execute.
          await logCycle({ cycleId, symbol, timeframe, step: "EE_EXEC", status: "INFO",
            message: `Calling Build EE paper execution for decisionId=${decisionId}` });
          const eeResult = await executePaperFromDecision(decision, decisionId, { allowConflicts: false });
          perSym.eePaperResult = eeResult.status;
          perSym.paperTradeId = eeResult.trade_id;

          if (eeResult.status === "PAPER_OPENED") {
            summary.paper_trades_opened += 1;
            await logCycle({ cycleId, symbol, timeframe, step: "EE_EXEC", status: "OK",
              message: `EE opened paper trade #${eeResult.trade_id} ${eeResult.action} @ ${eeResult.entry_price_filled}`,
              details: { execution: eeResult } });

            await applyCooldown(symbol, decision.action,
              `Cooldown after open trade #${eeResult.trade_id}`,
              settings.cooldownMinutesAfterTrade, { tradeId: eeResult.trade_id ?? undefined, decisionId });
            await logCycle({ cycleId, symbol, timeframe, step: "COOLDOWN", status: "OK",
              message: `Applied ${settings.cooldownMinutesAfterTrade}m cooldown after trade open`,
              details: { minutes: settings.cooldownMinutesAfterTrade } });
          } else {
            summary.paper_trades_rejected += 1;
            await logCycle({ cycleId, symbol, timeframe, step: "EE_EXEC", status: "SKIP",
              message: `EE rejected: ${eeResult.rejection_reason ?? eeResult.status}`,
              details: { execution: eeResult } });
          }
        } catch (err) {
          const msg = String(err).slice(0, 300);
          summary.errors.push(`${symbol}/${timeframe}: ${msg}`);
          perSym.skippedReason = "ERROR";
          await logCycle({ cycleId, symbol, timeframe, step: "AA_DECISION", status: "ERROR",
            message: `Per-symbol error: ${msg}`, details: { error: msg } });
        }

        summary.per_symbol.push(perSym);
      }
    }

    // 5. Monitor existing paper trades through EE.
    try {
      const monitor = await runPaperMonitor();
      summary.paper_trades_monitored = monitor.scanned;
      summary.paper_trades_closed = monitor.closed;
      await logCycle({ cycleId, step: "MONITOR", status: "OK",
        message: `EE monitor scanned=${monitor.scanned} closed=${monitor.closed}`,
        details: { monitor } });

      // After close, BB+CC fire automatically inside EE monitor. Apply
      // post-loss cooldown for any losing closure & count debriefs.
      for (const cl of monitor.closures) {
        await logCycle({ cycleId, symbol: cl.symbol, step: "CLOSE", status: "OK",
          message: `Paper trade #${cl.paperOrderId} closed via ${cl.hit} pnl=${cl.pnl}`,
          details: { closure: cl } });
        if (cl.bbStatus === "created") {
          summary.debriefs_triggered += 1;
          await logCycle({ cycleId, symbol: cl.symbol, step: "BB", status: "OK",
            message: `BB auto-debrief id=${cl.bbDebriefId} created for trade #${cl.paperOrderId}`,
            details: { debriefId: cl.bbDebriefId } });
          // CC learning event written by BB→CC handoff inside autoDebriefService.
          if (cl.bbDebriefId) {
            const lev = await db.select().from(learningEventsTable)
              .where(eq(learningEventsTable.debriefId, cl.bbDebriefId)).limit(1);
            if (lev[0]) {
              summary.learning_events_triggered += 1;
              await logCycle({ cycleId, symbol: cl.symbol, step: "CC", status: "OK",
                message: `CC learning event id=${lev[0].id} processed from debrief ${cl.bbDebriefId}`,
                details: { learningEventId: lev[0].id, mistakeTags: lev[0].mistakeTags } });
            }
          }
          if (cl.pnl < 0) {
            await applyCooldown(cl.symbol, cl.direction,
              `Post-loss cooldown after trade #${cl.paperOrderId}`,
              settings.cooldownMinutesAfterLoss, { tradeId: cl.paperOrderId });
            await logCycle({ cycleId, symbol: cl.symbol, step: "COOLDOWN", status: "OK",
              message: `Applied post-loss cooldown ${settings.cooldownMinutesAfterLoss}m`,
              details: { minutes: settings.cooldownMinutesAfterLoss } });
          }
        }
      }
    } catch (err) {
      const msg = String(err).slice(0, 300);
      summary.errors.push(`monitor: ${msg}`);
      await logCycle({ cycleId, step: "MONITOR", status: "ERROR", message: msg });
    }

    summary.status = summary.errors.length > 0 ? "FAILED"
      : summary.symbols_checked === 0 ? "SKIPPED"
      : "COMPLETED";
  } catch (err) {
    summary.status = "FAILED";
    summary.errors.push(String(err).slice(0, 300));
    await logCycle({ cycleId, step: "CYCLE_END", status: "ERROR", message: String(err).slice(0, 300) });
  }

  summary.finished_at = new Date().toISOString();
  await db.update(autopilotCyclesTable).set({
    status: summary.status,
    finishedAt: new Date(summary.finished_at),
    symbolsChecked: summary.symbols_checked,
    decisionsCreated: summary.decisions_created,
    paperTradesOpened: summary.paper_trades_opened,
    paperTradesRejected: summary.paper_trades_rejected,
    paperTradesMonitored: summary.paper_trades_monitored,
    paperTradesClosed: summary.paper_trades_closed,
    debriefsTriggered: summary.debriefs_triggered,
    learningEventsTriggered: summary.learning_events_triggered,
    warnings: summary.warnings,
    errors: summary.errors,
  }).where(eq(autopilotCyclesTable.id, cycRowId));

  await logCycle({ cycleId, step: "CYCLE_END", status: summary.status === "COMPLETED" ? "OK" : "WARN",
    message: `Cycle ${summary.status}: opened=${summary.paper_trades_opened} rejected=${summary.paper_trades_rejected} monitored=${summary.paper_trades_monitored} closed=${summary.paper_trades_closed}`,
    details: { summary } });

  return summary;
}
