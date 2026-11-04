// Ruby watch evaluator — the single place that turns an ACTIVE
// ruby_watch_instructions row into action. Called by the sweeper worker
// (lib/assistant/rubyWatchSweeper.ts) on an interval and by
// POST /me/assistant/watch/evaluate on demand. Everything runs inside the
// watch owner's feed scope so prices come from THEIR bridge, bound to a fresh
// observed tick (boundQuotePrice); no price → honest skip, never a guess.
//
// Kinds:
//  - WATCH_AND_ENTER / WATCH_AND_CLOSE: single-fire on a price trigger
//    (CAS ACTIVE→FIRED, then the SAME instant-trade router with every gate).
//  - MONITOR_TRADE (owner spec 2026-11-04): protective close on hard evidence;
//    reversal evidence → alert the trader (notification + chat), up to
//    MONITOR_MAX_UNANSWERED_ALERTS; still unanswered after the cooldown →
//    executive close. Policy is pure (rubyMonitorPolicy.ts); alert state lives
//    in the row's risk_params JSON.
// Authority + per-action permission are re-read at FIRE time (default-deny).

import {
  db,
  oneClickAuditTable,
  rubyWatchInstructionsTable,
  userOneClickSettingsTable,
  type RubyCommandKind,
  type RubyWatchInstruction,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { classifyTradeHealth, computeSlDistance, type OpenPositionInput } from "@workspace/domain/trade-health";
import type { InstantTradeIntent } from "../live/instantTrade.js";
import { readOpenPositions } from "../positions/openPositions.js";
import { routeCandles } from "../data/marketDataRouter.js";
import { feedScopeForUser, runWithFeedScope } from "../data/feedScope.js";
import { getUserActiveConnection } from "../brokerHub/connections.js";
import { computeTradeIntelligence } from "../intelligence/scoring.js";
import { notify } from "../notifications/service.js";
import { getAssistantDisplayName } from "./assistantName.js";
import { LATE_ENTRY_TOLERANCE, currentPriceOf, recordAndExecuteRuby } from "./rubyExecution.js";
import {
  MONITOR_MAX_UNANSWERED_ALERTS,
  acknowledgeKeep,
  alertCopy,
  decideMonitorAction,
  parseMonitorState,
  recordAlert,
  serializeMonitorState,
  type MonitorAlertState,
} from "./rubyMonitorPolicy.js";

export interface EvaluateOptions {
  ip?: string | null;
  ua?: string | null;
  trigger: "route" | "sweeper" | "ack";
  nowMs?: number;
}

export interface EvaluateResult {
  evaluated: number;
  fired: Array<{ watchId: number; kind: string; commandId?: string; blocked?: string; executive?: boolean }>;
  alerted: Array<{ watchId: number; alertNumber: number; reason: string }>;
  skipped: Array<{ watchId: number; reason: string }>;
}

const lookupActiveBridge = async (userId: number): Promise<number | null> =>
  (await getUserActiveConnection(userId))?.id ?? null;

async function markSkipped(watchId: number, reason: string): Promise<boolean> {
  const r = await db.update(rubyWatchInstructionsTable)
    .set({ status: "SKIPPED", skipReason: reason, updatedAt: new Date() })
    .where(and(eq(rubyWatchInstructionsTable.id, watchId), eq(rubyWatchInstructionsTable.status, "ACTIVE")))
    .returning({ id: rubyWatchInstructionsTable.id });
  return r.length > 0;
}

async function claimFire(watchId: number): Promise<boolean> {
  const r = await db.update(rubyWatchInstructionsTable)
    .set({ status: "FIRED", firedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(rubyWatchInstructionsTable.id, watchId), eq(rubyWatchInstructionsTable.status, "ACTIVE")))
    .returning({ id: rubyWatchInstructionsTable.id });
  return r.length > 0;
}

async function audit(userId: number, action: string, metadata: Record<string, unknown>, opts: EvaluateOptions): Promise<void> {
  try {
    await db.insert(oneClickAuditTable).values({
      userId, action, ip: opts.ip ?? null, userAgent: opts.ua ?? null,
      metadata: JSON.stringify({ ...metadata, trigger: opts.trigger, channel: "RUBY_WATCH_EVALUATOR" }),
    });
  } catch { /* evidence write must never block the evaluation */ }
}

async function reversalScoreFor(symbol: string, pos: OpenPositionInput): Promise<{ reversalRiskScore: number | null; recommendedAction: string | null }> {
  try {
    const series = await routeCandles(symbol, "15m", 60);
    const candlesM15 = series.ok
      ? series.candles.map((c) => ({ t: Date.parse(c.time), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }))
      : null;
    const out = computeTradeIntelligence({
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      unrealizedPnl: pos.floatingPnl,
      ageMinutes: pos.openedAtMs != null ? Math.max(0, (Date.now() - pos.openedAtMs) / 60_000) : null,
      candlesM15,
    });
    return { reversalRiskScore: out.scores.reversalRiskScore, recommendedAction: out.recommendedAction };
  } catch {
    return { reversalRiskScore: null, recommendedAction: null };
  }
}

async function saveMonitorState(watchId: number, state: MonitorAlertState): Promise<void> {
  await db.update(rubyWatchInstructionsTable)
    .set({ riskParams: serializeMonitorState(state), updatedAt: new Date() })
    .where(eq(rubyWatchInstructionsTable.id, watchId));
}

/** Evaluate every ACTIVE watch of ONE user inside that user's feed scope. */
export async function evaluateRubyWatchesForUser(userId: number, opts: EvaluateOptions): Promise<EvaluateResult> {
  return runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), () => evaluateInner(userId, opts));
}

async function evaluateInner(userId: number, opts: EvaluateOptions): Promise<EvaluateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const active = await db.select().from(rubyWatchInstructionsTable).where(and(
    eq(rubyWatchInstructionsTable.userId, userId),
    eq(rubyWatchInstructionsTable.status, "ACTIVE"),
  ));
  const out: EvaluateResult = { evaluated: active.length, fired: [], alerted: [], skipped: [] };
  if (active.length === 0) return out;

  // Re-read the CURRENT settings so permissions/authority are enforced at
  // FIRE-time, not only at arm-time (default-deny).
  const [settings] = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  const authority = (settings?.rubyExecutionAuthority ?? "OFF").trim().toUpperCase();
  const assistantName = await getAssistantDisplayName(userId);

  for (const w of active) {
    try {
      if (w.expiresAt && w.expiresAt.getTime() <= nowMs) {
        await db.update(rubyWatchInstructionsTable)
          .set({ status: "EXPIRED", updatedAt: new Date() })
          .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
        out.skipped.push({ watchId: w.id, reason: "EXPIRED" });
        continue;
      }
      if (w.kind === "MONITOR_TRADE") {
        await evaluateMonitor(w, { userId, settings, authority, assistantName, nowMs, opts, out });
        continue;
      }
      await evaluateTrigger(w, { userId, settings, authority, nowMs, opts, out });
    } catch (err) {
      out.skipped.push({ watchId: w.id, reason: "EVALUATOR_ERROR" });
      await audit(userId, "RUBY_WATCH_EVALUATOR_ERROR", { watchId: w.id, kind: w.kind, error: (err as Error).message?.slice(0, 300) }, opts);
    }
  }
  return out;
}

type Settings = typeof userOneClickSettingsTable.$inferSelect | undefined;

interface Ctx {
  userId: number;
  settings: Settings;
  authority: string;
  nowMs: number;
  opts: EvaluateOptions;
  out: EvaluateResult;
}

async function fireClose(w: RubyWatchInstruction, ctx: Ctx, args: { positionId: string; params: Record<string, unknown>; executive: boolean }): Promise<void> {
  if (!(await claimFire(w.id))) return; // lost the race — another evaluation fired it
  const intent: InstantTradeIntent = {
    source: w.source as InstantTradeIntent["source"], action: "CLOSE",
    accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol!,
    positionId: args.positionId, aiCommand: true, parsedByRuby: true,
    rawUserCommand: w.rawUserCommand, rubyCommandKind: "CLOSE",
  };
  const ledger = await recordAndExecuteRuby({
    userId: ctx.userId, intent, commandKind: "CLOSE_TRADE", symbol: w.symbol!,
    rawText: w.rawUserCommand ?? `[monitor ${w.id}]`, ip: ctx.opts.ip ?? null, ua: ctx.opts.ua ?? null,
    params: { watchId: w.id, managed: true, ...args.params },
  });
  if (ledger.duplicate) { ctx.out.skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" }); return; }
  await db.update(rubyWatchInstructionsTable)
    .set({ firedCommandId: ledger.result.ok ? (ledger.result.commandId ?? null) : null, updatedAt: new Date() })
    .where(eq(rubyWatchInstructionsTable.id, w.id));
  ctx.out.fired.push({
    watchId: w.id, kind: w.kind, executive: args.executive,
    commandId: ledger.result.ok ? ledger.result.commandId : undefined,
    blocked: ledger.result.ok ? undefined : (ledger.result.primaryReason ?? ledger.result.error),
  });
  await audit(ctx.userId, args.executive ? "RUBY_MONITOR_EXECUTIVE_CLOSE" : "RUBY_MONITOR_PROTECTIVE_CLOSE",
    { watchId: w.id, symbol: w.symbol, positionId: args.positionId, ok: ledger.result.ok, blocked: ledger.result.ok ? null : (ledger.result.primaryReason ?? ledger.result.error), ...args.params }, ctx.opts);
  const assistantName = await getAssistantDisplayName(ctx.userId);
  await notify({
    userId: ctx.userId, type: "TRADE", severity: "CRITICAL", sourceBuild: "LL",
    dedupeKey: `RUBY:WATCH:${w.id}:CLOSE`,
    title: `${w.symbol}: ${assistantName} ${ledger.result.ok ? "sent a close" : "could not close"}${args.executive ? " (no answer to 3 alerts)" : ""}`,
    message: ledger.result.ok
      ? `${assistantName} sent a CLOSE for your ${w.symbol} position (${String(args.params["reason"] ?? "protective exit")}). The fill is confirmed by the broker, not by this message.`
      : `${assistantName} tried to close your ${w.symbol} position (${String(args.params["reason"] ?? "protective exit")}) but a safety gate refused: ${ledger.result.primaryReason ?? ledger.result.error}. Please manage the position yourself.`,
    symbol: w.symbol, actionRequired: !ledger.result.ok,
    metadata: { watchId: w.id, executive: args.executive, commandId: ledger.result.ok ? ledger.result.commandId : null },
  }).catch(() => undefined);
}

async function evaluateMonitor(w: RubyWatchInstruction, c: Ctx & { assistantName: string }): Promise<void> {
  if (!w.symbol) { c.out.skipped.push({ watchId: w.id, reason: "NO_SYMBOL" }); return; }
  const openRows = (await readOpenPositions({ userId: c.userId, venue: "LIVE", basis: "UNCLOSED", symbol: w.symbol })).map((p) => p.row);
  const row = w.positionTicket
    ? openRows.find((o) => o.brokerTicket === w.positionTicket)
    : (openRows.length === 1 ? openRows[0] : undefined);
  if (!row) {
    if (await markSkipped(w.id, "POSITION_GONE")) c.out.skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
    return;
  }
  const mpx = await currentPriceOf(w.symbol);
  if (mpx == null) { c.out.skipped.push({ watchId: w.id, reason: "NO_PRICE" }); return; }
  const side: "BUY" | "SELL" = ["SELL", "SHORT"].includes(String(row.side).trim().toUpperCase()) ? "SELL" : "BUY";
  const pos: OpenPositionInput = {
    ticket: row.brokerTicket, symbol: w.symbol, side,
    lotSize: Number(row.volume ?? 0),
    entryPrice: Number.isFinite(Number(row.entryPrice)) ? Number(row.entryPrice) : null,
    currentPrice: mpx,
    stopLoss: row.stopLoss == null ? null : Number(row.stopLoss),
    takeProfit: row.takeProfit == null ? null : Number(row.takeProfit),
    floatingPnl: row.floatingPl == null ? null : Number(row.floatingPl),
    openedAtMs: row.openedAt ? row.openedAt.getTime() : null,
    priceAgeMs: null,
    accountMode: w.accountMode === "demo" ? "DEMO" : "LIVE",
  };
  const { state: health } = classifyTradeHealth(pos, null);
  const sl = computeSlDistance(pos);
  const atOrThroughStop = sl.known && sl.bufferRemainingPct != null && sl.bufferRemainingPct <= 0;
  const intel = await reversalScoreFor(w.symbol, pos);
  const monitorState = parseMonitorState(w.riskParams);
  const decision = decideMonitorAction({
    health, atOrThroughStop, reversalRiskScore: intel.reversalRiskScore, recommendedAction: intel.recommendedAction,
    state: monitorState, nowMs: c.nowMs,
  });
  if (decision.action === "NONE" || decision.action === "COOLDOWN") return;

  // Anything that executes needs AI_ASSISTED + allowRubyMonitor NOW.
  const revoked = c.authority !== "AI_ASSISTED" ? "RUBY_EXECUTION_NOT_AUTHORIZED"
    : c.settings?.allowRubyMonitor !== true ? "RUBY_MONITOR_NOT_ENABLED" : null;

  if (decision.action === "ALERT") {
    const at = new Date(c.nowMs).toISOString();
    const next = recordAlert(monitorState, { at, price: mpx, reversalRiskScore: intel.reversalRiskScore, health, reason: decision.reason });
    await saveMonitorState(w.id, next);
    const copy = alertCopy({ assistantName: c.assistantName, symbol: w.symbol, alertNumber: decision.alertNumber!, maxAlerts: MONITOR_MAX_UNANSWERED_ALERTS, reason: decision.reason, price: mpx, floatingPnl: pos.floatingPnl });
    await notify({
      userId: c.userId, type: "TRADE", severity: decision.alertNumber! >= MONITOR_MAX_UNANSWERED_ALERTS ? "HIGH" : "WARNING", sourceBuild: "LL",
      dedupeKey: `RUBY:WATCH:${w.id}:ALERT:${next.alertsSinceAck}:${next.keepCount}`,
      title: copy.title, message: revoked
        ? `${copy.message} (Note: ${c.assistantName} is not authorised to close for you — AI-Assisted authority or the monitor permission is off — so this stays an alert.)`
        : copy.message,
      symbol: w.symbol, actionRequired: true, recommendedAction: "Reply keep it / close it in chat",
      actionUrl: "/?ruby=watches",
      metadata: { watchId: w.id, alertNumber: decision.alertNumber, reversalRiskScore: intel.reversalRiskScore, health, price: mpx },
    }).catch(() => undefined);
    await audit(c.userId, "RUBY_MONITOR_REVERSAL_ALERT", { watchId: w.id, symbol: w.symbol, alertNumber: decision.alertNumber, reason: decision.reason, price: mpx, reversalRiskScore: intel.reversalRiskScore, health }, c.opts);
    c.out.alerted.push({ watchId: w.id, alertNumber: decision.alertNumber!, reason: decision.reason });
    return;
  }

  // PROTECTIVE_CLOSE or EXECUTIVE_CLOSE
  if (revoked) {
    if (await markSkipped(w.id, revoked)) c.out.skipped.push({ watchId: w.id, reason: revoked });
    await audit(c.userId, "RUBY_MONITOR_CLOSE_NOT_AUTHORIZED", { watchId: w.id, symbol: w.symbol, wanted: decision.action, reason: revoked }, c.opts);
    return;
  }
  await fireClose(w, c, {
    positionId: row.brokerTicket,
    executive: decision.action === "EXECUTIVE_CLOSE",
    params: { reason: decision.reason, healthState: health, firedPrice: mpx, reversalRiskScore: intel.reversalRiskScore, alertsUnanswered: monitorState.alertsSinceAck },
  });
}

async function evaluateTrigger(w: RubyWatchInstruction, c: Ctx): Promise<void> {
  if (!w.symbol || !w.triggerCondition) return;
  let cond: { op: ">=" | "<="; price: number };
  try { cond = JSON.parse(w.triggerCondition); } catch { return; }
  const px = await currentPriceOf(w.symbol);
  if (px == null) { c.out.skipped.push({ watchId: w.id, reason: "NO_PRICE" }); return; }
  const met = cond.op === ">=" ? px >= cond.price : px <= cond.price;
  if (!met) return;

  if (w.kind === "WATCH_AND_ENTER" && cond.price !== 0) {
    const overshoot = Math.abs(px - cond.price) / Math.abs(cond.price);
    if (overshoot > LATE_ENTRY_TOLERANCE) {
      if (await markSkipped(w.id, "LATE_SETUP_MOVED")) c.out.skipped.push({ watchId: w.id, reason: "LATE_SETUP_MOVED" });
      return;
    }
  }
  const permRevoked =
    c.authority !== "AI_ASSISTED" ? "RUBY_EXECUTION_NOT_AUTHORIZED"
    : w.kind === "WATCH_AND_ENTER" && c.settings?.allowRubyWatchEnter !== true ? "RUBY_WATCH_ENTER_NOT_ENABLED"
    : w.kind === "WATCH_AND_CLOSE" && c.settings?.allowRubyWatchClose !== true ? "RUBY_WATCH_CLOSE_NOT_ENABLED"
    : null;
  if (permRevoked) {
    if (await markSkipped(w.id, permRevoked)) c.out.skipped.push({ watchId: w.id, reason: permRevoked });
    return;
  }

  let intent: InstantTradeIntent;
  let commandKind: RubyCommandKind;
  if (w.kind === "WATCH_AND_ENTER") {
    intent = {
      source: w.source as InstantTradeIntent["source"], action: w.side === "SELL" ? "SELL" : "BUY",
      accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol,
      volume: w.lot ?? undefined, aiCommand: true, parsedByRuby: true,
      rawUserCommand: w.rawUserCommand, rubyCommandKind: "OPEN",
    };
    commandKind = "OPEN_TRADE";
  } else {
    const open = (await readOpenPositions({ userId: c.userId, venue: "LIVE", basis: "UNCLOSED", symbol: w.symbol })).map((p) => p.row);
    const row = w.positionTicket ? open.find((o) => o.brokerTicket === w.positionTicket) : (open.length === 1 ? open[0] : undefined);
    if (!row) {
      if (await markSkipped(w.id, "POSITION_GONE")) c.out.skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
      return;
    }
    intent = {
      source: w.source as InstantTradeIntent["source"], action: "CLOSE",
      accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol,
      positionId: row.brokerTicket, aiCommand: true, parsedByRuby: true,
      rawUserCommand: w.rawUserCommand, rubyCommandKind: "CLOSE",
    };
    commandKind = "CLOSE_TRADE";
  }
  if (!(await claimFire(w.id))) return;
  const ledger = await recordAndExecuteRuby({
    userId: c.userId, intent, commandKind, symbol: w.symbol,
    rawText: w.rawUserCommand ?? `[watch ${w.id}]`, ip: c.opts.ip ?? null, ua: c.opts.ua ?? null,
    params: { watchId: w.id, trigger: cond, firedPrice: px },
  });
  if (ledger.duplicate) { c.out.skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" }); return; }
  await db.update(rubyWatchInstructionsTable)
    .set({ firedCommandId: ledger.result.ok ? (ledger.result.commandId ?? null) : null, updatedAt: new Date() })
    .where(eq(rubyWatchInstructionsTable.id, w.id));
  c.out.fired.push({
    watchId: w.id, kind: w.kind,
    commandId: ledger.result.ok ? ledger.result.commandId : undefined,
    blocked: ledger.result.ok ? undefined : (ledger.result.primaryReason ?? ledger.result.error),
  });
  await audit(c.userId, "RUBY_WATCH_FIRED", { watchId: w.id, kind: w.kind, symbol: w.symbol, trigger: cond, firedPrice: px, ok: ledger.result.ok, blocked: ledger.result.ok ? null : (ledger.result.primaryReason ?? ledger.result.error) }, c.opts);
  const assistantName = await getAssistantDisplayName(c.userId);
  await notify({
    userId: c.userId, type: "TRADE", severity: ledger.result.ok ? "HIGH" : "CRITICAL", sourceBuild: "LL",
    dedupeKey: `RUBY:WATCH:${w.id}:FIRED`,
    title: `${w.symbol}: watch triggered at ${px}`,
    message: ledger.result.ok
      ? `${assistantName} sent your ${intent.action.toLowerCase()} ${w.symbol} to the broker at ${px} (trigger ${cond.op} ${cond.price}). The fill is confirmed by the broker, not by this message.`
      : `${assistantName}'s ${intent.action.toLowerCase()} ${w.symbol} at ${px} was refused by a safety gate: ${ledger.result.primaryReason ?? ledger.result.error}.`,
    symbol: w.symbol, actionRequired: !ledger.result.ok,
    metadata: { watchId: w.id, kind: w.kind, commandId: ledger.result.ok ? ledger.result.commandId : null },
  }).catch(() => undefined);
}

/**
 * The trader answered a reversal alert. "keep" resets the unanswered count and
 * keeps monitoring; "close" fires the close now through the same gated path
 * (the trader's own decision, so the extra-confirmation setting does not apply:
 * the alert was the question).
 */
export async function acknowledgeRubyWatch(userId: number, watchId: number, decision: "keep" | "close", opts: EvaluateOptions): Promise<
  | { ok: false; error: "WATCH_NOT_FOUND" | "WATCH_NOT_ACTIVE" | "NOT_A_MONITOR" }
  | { ok: true; decision: "keep"; alertsSinceAck: number }
  | { ok: true; decision: "close"; result: EvaluateResult }
> {
  const [w] = await db.select().from(rubyWatchInstructionsTable)
    .where(and(eq(rubyWatchInstructionsTable.id, watchId), eq(rubyWatchInstructionsTable.userId, userId))).limit(1);
  if (!w) return { ok: false, error: "WATCH_NOT_FOUND" };
  if (w.status !== "ACTIVE") return { ok: false, error: "WATCH_NOT_ACTIVE" };
  if (w.kind !== "MONITOR_TRADE") return { ok: false, error: "NOT_A_MONITOR" };
  const at = new Date(opts.nowMs ?? Date.now()).toISOString();
  if (decision === "keep") {
    const next = acknowledgeKeep(parseMonitorState(w.riskParams), at);
    await saveMonitorState(w.id, next);
    await audit(userId, "RUBY_MONITOR_ALERT_ACK_KEEP", { watchId: w.id, symbol: w.symbol, keepCount: next.keepCount }, opts);
    return { ok: true, decision: "keep", alertsSinceAck: next.alertsSinceAck };
  }
  return runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), async () => {
    const out: EvaluateResult = { evaluated: 1, fired: [], alerted: [], skipped: [] };
    const [settings] = await db.select().from(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
    const authority = (settings?.rubyExecutionAuthority ?? "OFF").trim().toUpperCase();
    const ctx: Ctx = { userId, settings, authority, nowMs: opts.nowMs ?? Date.now(), opts, out };
    const open = w.symbol ? (await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", symbol: w.symbol })).map((p) => p.row) : [];
    const row = w.positionTicket ? open.find((o) => o.brokerTicket === w.positionTicket) : (open.length === 1 ? open[0] : undefined);
    if (!row) {
      if (await markSkipped(w.id, "POSITION_GONE")) out.skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
      return { ok: true, decision: "close", result: out };
    }
    const revoked = authority !== "AI_ASSISTED" ? "RUBY_EXECUTION_NOT_AUTHORIZED" : settings?.allowRubyMonitor !== true ? "RUBY_MONITOR_NOT_ENABLED" : null;
    if (revoked) {
      if (await markSkipped(w.id, revoked)) out.skipped.push({ watchId: w.id, reason: revoked });
      return { ok: true, decision: "close", result: out };
    }
    const px = w.symbol ? await currentPriceOf(w.symbol) : null;
    await fireClose(w, ctx, { positionId: row.brokerTicket, executive: false, params: { reason: "you asked me to close after a reversal alert", firedPrice: px, userDecision: true } });
    return { ok: true, decision: "close", result: out };
  });
}

/** Read-only view of a user's watches for the chat panel and the assistant tool. */
export async function listRubyWatches(userId: number, opts: { includeFinished?: boolean; limit?: number } = {}) {
  const rows = await db.select().from(rubyWatchInstructionsTable)
    .where(eq(rubyWatchInstructionsTable.userId, userId));
  const sorted = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const picked = (opts.includeFinished ? sorted : sorted.filter((r) => r.status === "ACTIVE")).slice(0, opts.limit ?? 25);
  return picked.map((w) => {
    const m = w.kind === "MONITOR_TRADE" ? parseMonitorState(w.riskParams) : null;
    return {
      id: w.id, kind: w.kind, status: w.status, symbol: w.symbol, side: w.side, lot: w.lot,
      positionTicket: w.positionTicket,
      trigger: w.triggerCondition ? (JSON.parse(w.triggerCondition) as { op: string; price: number }) : null,
      expiresAt: w.expiresAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
      firedAt: w.firedAt?.toISOString() ?? null,
      skipReason: w.skipReason,
      monitor: m ? {
        alertsSinceAck: m.alertsSinceAck, maxAlerts: MONITOR_MAX_UNANSWERED_ALERTS,
        lastAlertAt: m.lastAlertAt, acknowledgedAt: m.acknowledgedAt, keepCount: m.keepCount,
        lastAlert: m.alerts.at(-1) ?? null,
        awaitingAnswer: m.alertsSinceAck > 0,
      } : null,
    };
  });
}
