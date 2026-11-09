// Eleanor watch evaluator — the single place that turns an ACTIVE
// eleanor_watch_instructions row into action. Called by the sweeper worker
// (lib/assistant/eleanorWatchSweeper.ts) on an interval and by
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
//    executive close. Policy is pure (eleanorMonitorPolicy.ts); alert state lives
//    in the row's risk_params JSON.
// Authority + per-action permission are re-read at FIRE time (default-deny).
//
// Sweep 2026-11-04 hardening:
//  - prices/candles that may trigger an action come ONLY from the owner's own
//    bridge (ownBridgePriceOf); a missing own-bridge tick means no action;
//  - positions are read on the confirmed-open basis and a row whose last
//    broker sync is older than POSITION_MAX_SYNC_AGE_MS is not acted on;
//  - monitor state writes are compare-and-set on the risk_params text read at
//    the start of the evaluation, and the fire claim CASes on it too, so a
//    concurrent "keep it" or fakeout-authority withdrawal wins over a stale
//    evaluation (the evaluation skips this cycle);
//  - an alert counts toward the executive close only once it was delivered;
//  - a refused or failed dispatch never leaves a watch FIRED: a monitor goes
//    back to ACTIVE with backoff (gives up after MONITOR_MAX_CLOSE_ATTEMPTS),
//    a one-shot watch ends SKIPPED with the reason; the trader is notified;
//  - watches run on the live account only (instant trading rejects demo).

import {
  db,
  oneClickAuditTable,
  eleanorWatchInstructionsTable,
  userOneClickSettingsTable,
  type EleanorCommandKind,
  type EleanorWatchInstruction,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { classifyTradeHealth, computeSlDistance, type OpenPositionInput } from "@workspace/domain/trade-health";
import type { InstantTradeIntent, InstantTradeResult } from "../live/instantTrade.js";
import { readOpenPositions } from "../positions/openPositions.js";
import { routeCandles } from "../data/marketDataRouter.js";
import { currentFeedScopeBridge, feedScopeForUser, runWithFeedScope } from "../data/feedScope.js";
import { getUserActiveConnection } from "../brokerHub/connections.js";
import { computeTradeIntelligence } from "../intelligence/scoring.js";
import { getSymbolProfile } from "../data/chart/symbolProfile.js";
import { notify } from "../notifications/service.js";
import { getAssistantDisplayName } from "./assistantName.js";
import { LATE_ENTRY_TOLERANCE, ownBridgePriceOf, recordAndExecuteEleanor, type EleanorLedgerOutcome } from "./eleanorExecution.js";
import { eleanorWatchPermissionBlock } from "./eleanorWatchPermissions.js";
import { adverseWickPct, decideFakeoutAdjustment, fakeoutCopy, type FakeoutBar } from "./eleanorFakeoutPolicy.js";
import {
  MONITOR_MAX_UNANSWERED_ALERTS,
  acknowledgeKeep,
  alertCopy,
  decideMonitorAction,
  expireStaleAlertRun,
  inCloseBackoff,
  noteEvaluation,
  parseMonitorState,
  recordAlert,
  recordCloseFailure,
  recordFakeoutAdjustment,
  setFakeoutAuthority,
  MONITOR_REVERSAL_SCORE_THRESHOLD,
  serializeMonitorState,
  type MonitorAlertState,
} from "./eleanorMonitorPolicy.js";

/** A position row whose last broker sync is older than this is not acted on. */
export const POSITION_MAX_SYNC_AGE_MS = 2 * 60_000;

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
  /** Fakeout SL/TP shifts Eleanor sent (or tried to) under the trader's per-monitor authority. */
  adjusted: Array<{ watchId: number; action: "SHIFT_SL" | "SHIFT_TP"; newStopLoss: number | null; newTakeProfit: number | null; commandId?: string; blocked?: string }>;
  skipped: Array<{ watchId: number; reason: string }>;
}

const lookupActiveBridge = async (userId: number): Promise<number | null> =>
  (await getUserActiveConnection(userId))?.id ?? null;

const riskParamsIs = (raw: string | null) =>
  raw == null ? isNull(eleanorWatchInstructionsTable.riskParams) : eq(eleanorWatchInstructionsTable.riskParams, raw);

/** End an ACTIVE watch (CAS on status). */
async function markEnded(watchId: number, status: "SKIPPED" | "EXPIRED", reason: string): Promise<boolean> {
  const r = await db.update(eleanorWatchInstructionsTable)
    .set({ status, skipReason: reason, updatedAt: new Date() })
    .where(and(eq(eleanorWatchInstructionsTable.id, watchId), eq(eleanorWatchInstructionsTable.status, "ACTIVE")))
    .returning({ id: eleanorWatchInstructionsTable.id });
  return r.length > 0;
}
const markSkipped = (watchId: number, reason: string) => markEnded(watchId, "SKIPPED", reason);

/**
 * ACTIVE → FIRED, single winner. With `cas`, the claim also requires the
 * risk_params text to be exactly what this evaluation read (so an ack or an
 * authority change made meanwhile makes the claim miss) and stores the
 * evaluation's state in the same write.
 */
async function claimFire(watchId: number, cas?: { expectedRaw: string | null; nextRaw: string }): Promise<boolean> {
  const r = await db.update(eleanorWatchInstructionsTable)
    .set({ status: "FIRED", firedAt: new Date(), updatedAt: new Date(), ...(cas ? { riskParams: cas.nextRaw } : {}) })
    .where(and(
      eq(eleanorWatchInstructionsTable.id, watchId),
      eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
      ...(cas ? [riskParamsIs(cas.expectedRaw)] : []),
    ))
    .returning({ id: eleanorWatchInstructionsTable.id });
  return r.length > 0;
}

/** FIRED → ACTIVE after a dispatch that did not go out (monitor retry). */
async function revertToActive(watchId: number, nextRaw: string): Promise<void> {
  await db.update(eleanorWatchInstructionsTable)
    .set({ status: "ACTIVE", firedAt: null, riskParams: nextRaw, updatedAt: new Date() })
    .where(and(eq(eleanorWatchInstructionsTable.id, watchId), eq(eleanorWatchInstructionsTable.status, "FIRED")));
}

/** FIRED → SKIPPED with the reason, when the dispatch was refused for good. */
async function endFired(watchId: number, reason: string, nextRaw?: string): Promise<void> {
  await db.update(eleanorWatchInstructionsTable)
    .set({ status: "SKIPPED", skipReason: reason.slice(0, 200), updatedAt: new Date(), ...(nextRaw ? { riskParams: nextRaw } : {}) })
    .where(and(eq(eleanorWatchInstructionsTable.id, watchId), eq(eleanorWatchInstructionsTable.status, "FIRED")));
}

/** CAS write of monitor state; returns the stored text, or null on a miss. */
async function casMonitorState(watchId: number, expectedRaw: string | null, next: MonitorAlertState): Promise<string | null> {
  const nextRaw = serializeMonitorState(next);
  const r = await db.update(eleanorWatchInstructionsTable)
    .set({ riskParams: nextRaw, updatedAt: new Date() })
    .where(and(
      eq(eleanorWatchInstructionsTable.id, watchId),
      eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
      riskParamsIs(expectedRaw),
    ))
    .returning({ id: eleanorWatchInstructionsTable.id });
  return r.length > 0 ? nextRaw : null;
}

type MonitorMutationError = "WATCH_NOT_FOUND" | "WATCH_NOT_ACTIVE" | "NOT_A_MONITOR" | "WATCH_BUSY";

/** Read-modify-CAS on an ACTIVE monitor's state, retried on a concurrent write. */
async function mutateMonitorState(userId: number, watchId: number, fn: (s: MonitorAlertState) => MonitorAlertState): Promise<{ ok: false; error: MonitorMutationError } | { ok: true; state: MonitorAlertState; watch: EleanorWatchInstruction }> {
  for (let i = 0; i < 3; i++) {
    const [w] = await db.select().from(eleanorWatchInstructionsTable)
      .where(and(eq(eleanorWatchInstructionsTable.id, watchId), eq(eleanorWatchInstructionsTable.userId, userId))).limit(1);
    if (!w) return { ok: false, error: "WATCH_NOT_FOUND" };
    if (w.status !== "ACTIVE") return { ok: false, error: "WATCH_NOT_ACTIVE" };
    if (w.kind !== "MONITOR_TRADE") return { ok: false, error: "NOT_A_MONITOR" };
    const next = fn(parseMonitorState(w.riskParams));
    if (await casMonitorState(w.id, w.riskParams ?? null, next)) return { ok: true, state: next, watch: w };
  }
  return { ok: false, error: "WATCH_BUSY" };
}

async function audit(userId: number, action: string, metadata: Record<string, unknown>, opts: EvaluateOptions): Promise<void> {
  try {
    await db.insert(oneClickAuditTable).values({
      userId, action, ip: opts.ip ?? null, userAgent: opts.ua ?? null,
      metadata: JSON.stringify({ ...metadata, trigger: opts.trigger, channel: "ELEANOR_WATCH_EVALUATOR" }),
    });
  } catch { /* evidence write must never block the evaluation */ }
}

/** Notify; true only when a notification was actually stored for the user. */
async function deliver(input: Parameters<typeof notify>[0]): Promise<boolean> {
  try {
    const r = await notify(input);
    return r.status === "CREATED" || r.status === "UPDATED";
  } catch { return false; }
}

function priceDigits(symbol: string): number {
  try {
    const d = getSymbolProfile(symbol).pricePrecision;
    return Number.isInteger(d) && d >= 0 && d <= 10 ? d : 5;
  } catch { return 5; }
}

async function reversalScoreFor(symbol: string, pos: OpenPositionInput, bridge: number | null, nowMs: number): Promise<{ reversalRiskScore: number | null; recommendedAction: string | null; fakeoutRiskScore: number | null; lastCompletedBar: FakeoutBar | null }> {
  try {
    // Only the owner's own bridge series may drive a decision: pinned read,
    // and a served series from any other writer/provider (incl. the
    // unattributed durable mirror) is ignored.
    const series = bridge != null ? await routeCandles(symbol, "15m", 60, { bridgeConnectionId: bridge }) : null;
    const own = !!series && series.ok && series.provenance?.providerId === "mt5_broker"
      && series.provenance.subProviderId == null && series.provenance.bridgeConnectionId === bridge;
    const candlesM15 = own
      ? series!.candles.map((c) => ({ t: Date.parse(c.time), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }))
      : null;
    // The newest bar may still be forming; the fakeout rule reads the last
    // COMPLETED bar so a half-formed wick never triggers a shift.
    const completed = candlesM15 && candlesM15.length >= 2 ? candlesM15[candlesM15.length - 2]! : null;
    const lastCompletedBar: FakeoutBar | null = completed ? { o: completed.o, h: completed.h, l: completed.l, c: completed.c, t: Number.isFinite(completed.t) ? completed.t : null } : null;
    const fakeoutOut = completed ? computeTradeIntelligence({
      symbol, side: pos.side, entryPrice: pos.entryPrice, currentPrice: pos.currentPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
      unrealizedPnl: pos.floatingPnl, ageMinutes: null, candlesM15: candlesM15!.slice(0, -1),
    }) : null;
    const out = computeTradeIntelligence({
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      unrealizedPnl: pos.floatingPnl,
      ageMinutes: pos.openedAtMs != null ? Math.max(0, (nowMs - pos.openedAtMs) / 60_000) : null,
      candlesM15,
    });
    return { reversalRiskScore: out.scores.reversalRiskScore, recommendedAction: out.recommendedAction, fakeoutRiskScore: fakeoutOut?.scores.fakeoutRiskScore ?? null, lastCompletedBar };
  } catch {
    return { reversalRiskScore: null, recommendedAction: null, fakeoutRiskScore: null, lastCompletedBar: null };
  }
}

type PositionRow = Awaited<ReturnType<typeof readOpenPositions<"LIVE">>>[number];

/**
 * The watched position on the confirmed-open basis (IGNORED / EXTERNAL rows
 * excluded). GONE when it is no longer open; STALE when its last broker sync
 * is too old to act on.
 */
async function findWatchedPosition(userId: number, w: EleanorWatchInstruction, nowMs: number): Promise<{ kind: "GONE" } | { kind: "STALE" } | { kind: "OK"; p: PositionRow }> {
  const rows = await readOpenPositions({ userId, venue: "LIVE", basis: "CONFIRMED_OPEN", symbol: w.symbol! });
  const p = w.positionTicket ? rows.find((o) => o.row.brokerTicket === w.positionTicket) : (rows.length === 1 ? rows[0] : undefined);
  if (!p) return { kind: "GONE" };
  const syncedMs = p.observedAt ? p.observedAt.getTime() : NaN;
  if (!Number.isFinite(syncedMs) || nowMs - syncedMs > POSITION_MAX_SYNC_AGE_MS) return { kind: "STALE" };
  return { kind: "OK", p };
}

/** Evaluate every ACTIVE watch of ONE user inside that user's feed scope. */
export async function evaluateEleanorWatchesForUser(userId: number, opts: EvaluateOptions): Promise<EvaluateResult> {
  return runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), () => evaluateInner(userId, opts));
}

async function evaluateInner(userId: number, opts: EvaluateOptions): Promise<EvaluateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const active = await db.select().from(eleanorWatchInstructionsTable).where(and(
    eq(eleanorWatchInstructionsTable.userId, userId),
    eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
  ));
  const out: EvaluateResult = { evaluated: active.length, fired: [], alerted: [], adjusted: [], skipped: [] };
  if (active.length === 0) return out;

  // Re-read the CURRENT settings so permissions/authority are enforced at
  // FIRE-time, not only at arm-time (default-deny).
  const [settings] = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  const authority = (settings?.eleanorExecutionAuthority ?? "OFF").trim().toUpperCase();
  const assistantName = await getAssistantDisplayName(userId);
  // The owner's own bridge — the only feed a watch may act on.
  const bridge = await currentFeedScopeBridge();

  for (const w of active) {
    try {
      if (w.expiresAt && w.expiresAt.getTime() <= nowMs) {
        if (await markEnded(w.id, "EXPIRED", "EXPIRED")) out.skipped.push({ watchId: w.id, reason: "EXPIRED" });
        continue;
      }
      if (w.accountMode !== "live") {
        // Instant trading is live-only; a demo watch could never execute.
        if (await markSkipped(w.id, "LIVE_ACCOUNT_ONLY")) {
          out.skipped.push({ watchId: w.id, reason: "LIVE_ACCOUNT_ONLY" });
          await deliver({
            userId, type: "TRADE", severity: "WARNING", sourceBuild: "LL", dedupeKey: `ELEANOR:WATCH:${w.id}:LIVE_ONLY`,
            title: `${w.symbol ?? "Watch"}: ${assistantName} stopped a demo watch`,
            message: `Watches run on your live account only in this build, so ${assistantName} has stopped this one. Switch to live and ask again to arm it.`,
            symbol: w.symbol, actionRequired: false, metadata: { watchId: w.id },
          });
        }
        continue;
      }
      if (w.kind === "MONITOR_TRADE") {
        await evaluateMonitor(w, { userId, settings, authority, assistantName, nowMs, opts, out, bridge });
        continue;
      }
      await evaluateTrigger(w, { userId, settings, authority, assistantName, nowMs, opts, out, bridge });
    } catch (err) {
      out.skipped.push({ watchId: w.id, reason: "EVALUATOR_ERROR" });
      await audit(userId, "ELEANOR_WATCH_EVALUATOR_ERROR", { watchId: w.id, kind: w.kind, error: (err as Error).message?.slice(0, 300) }, opts);
    }
  }
  return out;
}

type Settings = typeof userOneClickSettingsTable.$inferSelect | undefined;

interface Ctx {
  userId: number;
  settings: Settings;
  authority: string;
  assistantName: string;
  nowMs: number;
  opts: EvaluateOptions;
  out: EvaluateResult;
  bridge: number | null;
}

const blockedReason = (l: EleanorLedgerOutcome & { duplicate: false }) =>
  l.result.ok ? null : (l.result.primaryReason ?? l.result.error ?? "REFUSED");

/**
 * Close the monitored position. `expectedRaw` is the risk_params text this
 * evaluation started from; the claim misses (and nothing is sent) when the
 * trader acknowledged or changed authority meanwhile.
 */
async function fireClose(w: EleanorWatchInstruction, ctx: Ctx, args: { positionId: string; params: Record<string, unknown>; executive: boolean; expectedRaw: string | null; state: MonitorAlertState }): Promise<void> {
  const claimRaw = serializeMonitorState(args.state);
  if (!(await claimFire(w.id, { expectedRaw: args.expectedRaw, nextRaw: claimRaw }))) {
    ctx.out.skipped.push({ watchId: w.id, reason: "STATE_CHANGED" });
    return;
  }
  const intent: InstantTradeIntent = {
    source: w.source as InstantTradeIntent["source"], action: "CLOSE",
    accountMode: "live", symbol: w.symbol!,
    positionId: args.positionId, aiCommand: true, parsedByEleanor: true,
    rawUserCommand: w.rawUserCommand, eleanorCommandKind: "CLOSE",
  };
  const reasonText = String(args.params["reason"] ?? "protective exit");
  let ledger: EleanorLedgerOutcome;
  try {
    ledger = await recordAndExecuteEleanor({
      userId: ctx.userId, intent, commandKind: "CLOSE_TRADE", symbol: w.symbol!,
      rawText: w.rawUserCommand ?? `[monitor ${w.id}]`, ip: ctx.opts.ip ?? null, ua: ctx.opts.ua ?? null,
      params: { watchId: w.id, managed: true, ...args.params },
    });
  } catch (err) {
    ledger = { duplicate: false, commandRowId: -1, handshakeStatus: "UNKNOWN", result: { ok: false, httpStatus: 500, error: `DISPATCH_ERROR: ${(err as Error).message ?? err}`.slice(0, 200) } satisfies InstantTradeResult };
  }
  if (ledger.duplicate) {
    // A matching close is already in flight: keep monitoring; the next cycle
    // sees the position gone or tries again.
    await revertToActive(w.id, claimRaw);
    ctx.out.skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" });
    return;
  }
  const blocked = blockedReason(ledger);
  let retryNote = "";
  if (blocked) {
    const f = recordCloseFailure(args.state, ctx.nowMs);
    if (f.giveUp) {
      await endFired(w.id, `CLOSE_REFUSED: ${blocked}`, serializeMonitorState(f.state));
      retryNote = ` I have tried ${f.state.closeAttempts} times and stopped monitoring this position.`;
    } else {
      await revertToActive(w.id, serializeMonitorState(f.state));
      retryNote = ` I will try again in about ${Math.round((f.retryInMs ?? 60_000) / 60_000)} min while the reason stands.`;
    }
  } else {
    await db.update(eleanorWatchInstructionsTable)
      .set({ firedCommandId: ledger.result.ok ? (ledger.result.commandId ?? null) : null, updatedAt: new Date() })
      .where(eq(eleanorWatchInstructionsTable.id, w.id));
  }
  ctx.out.fired.push({
    watchId: w.id, kind: w.kind, executive: args.executive,
    commandId: ledger.result.ok ? ledger.result.commandId : undefined,
    blocked: blocked ?? undefined,
  });
  await audit(ctx.userId, args.executive ? "ELEANOR_MONITOR_EXECUTIVE_CLOSE" : "ELEANOR_MONITOR_PROTECTIVE_CLOSE",
    { watchId: w.id, symbol: w.symbol, positionId: args.positionId, ok: ledger.result.ok, blocked, ...args.params }, ctx.opts);
  await deliver({
    userId: ctx.userId, type: "TRADE", severity: "CRITICAL", sourceBuild: "LL",
    dedupeKey: `ELEANOR:WATCH:${w.id}:CLOSE`,
    title: `${w.symbol}: ${ctx.assistantName} ${ledger.result.ok ? "sent a close" : "could not close"}${args.executive ? " (no answer to 3 alerts)" : ""}`,
    message: ledger.result.ok
      ? `${ctx.assistantName} sent a CLOSE for your ${w.symbol} position (${reasonText}). The fill is confirmed by the broker, not by this message.`
      : `${ctx.assistantName} tried to close your ${w.symbol} position (${reasonText}) but it did not go through: ${blocked}.${retryNote} Please manage the position yourself.`,
    symbol: w.symbol, actionRequired: !ledger.result.ok,
    metadata: { watchId: w.id, executive: args.executive, commandId: ledger.result.ok ? ledger.result.commandId : null },
  });
}

// Owner spec 2026-11-04: with the trader's per-monitor opt-in, Eleanor may shift
// the stop loss / take profit when a fakeout is in progress. Authority is
// re-checked at fire time (AI_ASSISTED + allowEleanorModifyCommands + the
// monitor's own opt-in); the shift goes through recordAndExecuteEleanor →
// instant-trade MODIFY_SL_TP, so every server gate runs. The watch stays
// ACTIVE (a shift is management, not a fire).
async function maybeShiftOnFakeout(
  w: EleanorWatchInstruction,
  c: Ctx,
  a: { row: { brokerTicket: string | null }; pos: OpenPositionInput; mpx: number; atOrThroughStop: boolean; monitorState: MonitorAlertState; expectedRaw: string | null;
       intel: { reversalRiskScore: number | null; fakeoutRiskScore: number | null; lastCompletedBar: FakeoutBar | null } },
): Promise<void> {
  if (!a.row.brokerTicket || !w.symbol) return;
  const decision = decideFakeoutAdjustment({
    side: a.pos.side, entryPrice: a.pos.entryPrice, currentPrice: a.mpx, stopLoss: a.pos.stopLoss, takeProfit: a.pos.takeProfit,
    originalStopLoss: a.monitorState.originalStopLoss,
    lastBar: a.intel.lastCompletedBar, fakeoutRiskScore: a.intel.fakeoutRiskScore, reversalRiskScore: a.intel.reversalRiskScore,
    reversalThreshold: MONITOR_REVERSAL_SCORE_THRESHOLD, atOrThroughStop: a.atOrThroughStop,
    adjustmentsSoFar: a.monitorState.fakeoutAdjustments.filter((r) => r.ok).length, lastAdjustAt: a.monitorState.lastFakeoutAdjustAt, nowMs: c.nowMs,
    failedSoFar: a.monitorState.fakeoutAdjustments.filter((r) => !r.ok).length,
    lastFakeoutBarAt: a.monitorState.lastFakeoutBarAt,
    digits: priceDigits(w.symbol),
  });
  const barAt = a.intel.lastCompletedBar?.t ?? null;
  if (decision.action === "NONE") return;
  const revoked = c.authority !== "AI_ASSISTED" ? "ELEANOR_EXECUTION_NOT_AUTHORIZED"
    : c.settings?.allowEleanorModifyCommands !== true ? "ELEANOR_MODIFY_COMMANDS_NOT_ENABLED" : null;
  const at = new Date(c.nowMs).toISOString();
  const rec = (ok: boolean, blocked: string | null) => ({ at, price: a.mpx, fakeoutRiskScore: adverseWickPct(a.pos.side, a.intel.lastCompletedBar), fromStopLoss: a.pos.stopLoss, toStopLoss: decision.newStopLoss, fromTakeProfit: a.pos.takeProfit, toTakeProfit: decision.newTakeProfit, reason: decision.reason, ok, blocked });
  if (revoked) {
    await casMonitorState(w.id, a.expectedRaw, { ...recordFakeoutAdjustment(a.monitorState, rec(false, revoked)), lastFakeoutAdjustAt: at, lastFakeoutBarAt: barAt });
    await audit(c.userId, "ELEANOR_FAKEOUT_SHIFT_NOT_AUTHORIZED", { watchId: w.id, symbol: w.symbol, wanted: decision.action, reason: revoked }, c.opts);
    return;
  }
  // Claim the shift first (cooldown stamp, CAS on the state this evaluation
  // read): a concurrent withdrawal of fakeout authority makes the claim miss.
  if (!(await casMonitorState(w.id, a.expectedRaw, { ...a.monitorState, lastFakeoutAdjustAt: at, lastFakeoutBarAt: barAt }))) {
    c.out.skipped.push({ watchId: w.id, reason: "STATE_CHANGED" });
    return;
  }
  const intent: InstantTradeIntent = {
    source: w.source as InstantTradeIntent["source"], action: "MODIFY_SL_TP",
    accountMode: "live", symbol: w.symbol,
    positionId: a.row.brokerTicket, newStopLoss: decision.newStopLoss, newTakeProfit: decision.newTakeProfit,
    aiCommand: true, parsedByEleanor: true, rawUserCommand: w.rawUserCommand, eleanorCommandKind: "MODIFY",
  };
  let ok = false;
  let blocked: string | null = null;
  let commandId: string | undefined;
  try {
    const ledger = await recordAndExecuteEleanor({
      userId: c.userId, intent, commandKind: "MODIFY_SL_TP", symbol: w.symbol,
      rawText: w.rawUserCommand ?? `[monitor ${w.id} fakeout]`, ip: c.opts.ip ?? null, ua: c.opts.ua ?? null,
      params: { watchId: w.id, managed: true, fakeout: true, reason: decision.reason, price: a.mpx, adverseWickPct: adverseWickPct(a.pos.side, a.intel.lastCompletedBar) },
    });
    if (ledger.duplicate) { c.out.skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" }); return; }
    ok = ledger.result.ok;
    blocked = blockedReason(ledger);
    commandId = ledger.result.ok ? ledger.result.commandId : undefined;
  } catch (err) {
    blocked = `DISPATCH_ERROR: ${(err as Error).message ?? err}`.slice(0, 200);
  }
  await mutateMonitorState(c.userId, w.id, (s) => recordFakeoutAdjustment(s, rec(ok, blocked)));
  c.out.adjusted.push({ watchId: w.id, action: decision.action, newStopLoss: decision.newStopLoss, newTakeProfit: decision.newTakeProfit, commandId, blocked: blocked ?? undefined });
  await audit(c.userId, "ELEANOR_FAKEOUT_SHIFT", { watchId: w.id, symbol: w.symbol, positionId: a.row.brokerTicket, action: decision.action, newStopLoss: decision.newStopLoss, newTakeProfit: decision.newTakeProfit, reason: decision.reason, ok, blocked }, c.opts);
  const copy = fakeoutCopy({ assistantName: c.assistantName, symbol: w.symbol, decision, ok, blocked });
  await deliver({
    userId: c.userId, type: "TRADE", severity: ok ? "HIGH" : "CRITICAL", sourceBuild: "LL",
    dedupeKey: `ELEANOR:WATCH:${w.id}:FAKEOUT:${a.monitorState.fakeoutAdjustments.length + 1}`,
    title: copy.title, message: copy.message, symbol: w.symbol, actionRequired: !ok,
    metadata: { watchId: w.id, action: decision.action, newStopLoss: decision.newStopLoss, newTakeProfit: decision.newTakeProfit, commandId: commandId ?? null },
  });
}

function toPositionInput(row: PositionRow["row"], symbol: string, mpx: number): OpenPositionInput {
  const side: "BUY" | "SELL" = ["SELL", "SHORT"].includes(String(row.side).trim().toUpperCase()) ? "SELL" : "BUY";
  return {
    ticket: row.brokerTicket, symbol, side,
    lotSize: Number(row.volume ?? 0),
    entryPrice: Number.isFinite(Number(row.entryPrice)) ? Number(row.entryPrice) : null,
    currentPrice: mpx,
    stopLoss: row.stopLoss == null ? null : Number(row.stopLoss),
    takeProfit: row.takeProfit == null ? null : Number(row.takeProfit),
    floatingPnl: row.floatingPl == null ? null : Number(row.floatingPl),
    openedAtMs: row.openedAt ? row.openedAt.getTime() : null,
    priceAgeMs: null,
    accountMode: "LIVE",
  };
}

async function evaluateMonitor(w: EleanorWatchInstruction, c: Ctx): Promise<void> {
  if (!w.symbol) { c.out.skipped.push({ watchId: w.id, reason: "NO_SYMBOL" }); return; }
  // The risk_params text this evaluation starts from: every state write and
  // the fire claim CAS on it.
  const startRaw = w.riskParams ?? null;
  const found = await findWatchedPosition(c.userId, w, c.nowMs);
  if (found.kind === "GONE") {
    // The monitor's job ends with the position.
    if (await markEnded(w.id, "EXPIRED", "POSITION_CLOSED")) c.out.skipped.push({ watchId: w.id, reason: "POSITION_CLOSED" });
    return;
  }
  if (found.kind === "STALE") { c.out.skipped.push({ watchId: w.id, reason: "POSITION_STALE" }); return; }
  const row = found.p.row;
  const mpx = await ownBridgePriceOf(w.symbol, c.bridge);
  if (mpx == null) { c.out.skipped.push({ watchId: w.id, reason: "NO_PRICE" }); return; }
  const pos = toPositionInput(row, w.symbol, mpx);
  const { state: health } = classifyTradeHealth(pos, null);
  const sl = computeSlDistance(pos);
  const atOrThroughStop = sl.known && sl.bufferRemainingPct != null && sl.bufferRemainingPct <= 0;
  const intel = await reversalScoreFor(w.symbol, pos, c.bridge, c.nowMs);

  let state = expireStaleAlertRun(parseMonitorState(startRaw), c.nowMs);
  if (state.originalStopLoss == null && pos.stopLoss != null) state = { ...state, originalStopLoss: pos.stopLoss };
  const decision = decideMonitorAction({
    health, atOrThroughStop, reversalRiskScore: intel.reversalRiskScore, recommendedAction: intel.recommendedAction,
    state, nowMs: c.nowMs,
  });
  state = noteEvaluation(state, decision.action);
  const changed = serializeMonitorState(state) !== serializeMonitorState(parseMonitorState(startRaw));

  if (decision.action === "NONE" || decision.action === "COOLDOWN") {
    let raw = startRaw;
    if (changed) {
      raw = await casMonitorState(w.id, startRaw, state);
      if (raw == null) { c.out.skipped.push({ watchId: w.id, reason: "STATE_CHANGED" }); return; }
    }
    // No close is due. If the trader gave fakeout authority for this monitor,
    // Eleanor may shift SL/TP once per cooldown under the bounded fakeout rule.
    if (state.fakeoutAuthority) {
      await maybeShiftOnFakeout(w, c, { row, pos, mpx, atOrThroughStop, monitorState: state, expectedRaw: raw, intel });
    }
    return;
  }

  // Anything that executes needs AI_ASSISTED + the monitor permission + the
  // pipeline's close permission NOW.
  const revoked = eleanorWatchPermissionBlock("MONITOR_TRADE", c.settings);

  if (decision.action === "ALERT") {
    const at = new Date(c.nowMs).toISOString();
    const next = recordAlert(state, { at, price: mpx, reversalRiskScore: intel.reversalRiskScore, health, reason: decision.reason });
    const copy = alertCopy({ assistantName: c.assistantName, symbol: w.symbol, alertNumber: decision.alertNumber!, maxAlerts: MONITOR_MAX_UNANSWERED_ALERTS, reason: decision.reason, price: mpx, floatingPnl: pos.floatingPnl });
    const delivered = await deliver({
      userId: c.userId, type: "TRADE", severity: decision.alertNumber! >= MONITOR_MAX_UNANSWERED_ALERTS ? "HIGH" : "WARNING", sourceBuild: "LL",
      dedupeKey: `ELEANOR:WATCH:${w.id}:ALERT:${next.alertsSinceAck}:${next.keepCount}:${next.alerts.length}`,
      title: copy.title, message: revoked
        ? `${copy.message} (Note: ${c.assistantName} is not authorised to close for you — AI-Assisted authority, the monitor permission or the close permission is off — so this stays an alert.)`
        : copy.message,
      symbol: w.symbol, actionRequired: true, recommendedAction: "Reply keep it / close it in chat",
      actionUrl: "/?eleanor=watches",
      metadata: { watchId: w.id, alertNumber: decision.alertNumber, reversalRiskScore: intel.reversalRiskScore, health, price: mpx },
    });
    if (!delivered) {
      // A muted or failed alert is not an alert the trader could answer: it
      // never counts toward the executive close.
      if (changed) await casMonitorState(w.id, startRaw, state);
      await audit(c.userId, "ELEANOR_MONITOR_ALERT_NOT_DELIVERED", { watchId: w.id, symbol: w.symbol, alertNumber: decision.alertNumber, reason: decision.reason }, c.opts);
      c.out.skipped.push({ watchId: w.id, reason: "ALERT_NOT_DELIVERED" });
      return;
    }
    if (!(await casMonitorState(w.id, startRaw, next))) {
      c.out.skipped.push({ watchId: w.id, reason: "STATE_CHANGED" });
      return;
    }
    await audit(c.userId, "ELEANOR_MONITOR_REVERSAL_ALERT", { watchId: w.id, symbol: w.symbol, alertNumber: decision.alertNumber, reason: decision.reason, price: mpx, reversalRiskScore: intel.reversalRiskScore, health }, c.opts);
    c.out.alerted.push({ watchId: w.id, alertNumber: decision.alertNumber!, reason: decision.reason });
    return;
  }

  // PROTECTIVE_CLOSE or EXECUTIVE_CLOSE
  if (revoked) {
    if (await markSkipped(w.id, revoked)) c.out.skipped.push({ watchId: w.id, reason: revoked });
    await audit(c.userId, "ELEANOR_MONITOR_CLOSE_NOT_AUTHORIZED", { watchId: w.id, symbol: w.symbol, wanted: decision.action, reason: revoked }, c.opts);
    return;
  }
  if (inCloseBackoff(state, c.nowMs)) {
    if (changed) await casMonitorState(w.id, startRaw, state);
    c.out.skipped.push({ watchId: w.id, reason: "CLOSE_BACKOFF" });
    return;
  }
  await fireClose(w, c, {
    positionId: row.brokerTicket,
    executive: decision.action === "EXECUTIVE_CLOSE",
    expectedRaw: startRaw, state,
    params: { reason: decision.reason, healthState: health, firedPrice: mpx, reversalRiskScore: intel.reversalRiskScore, alertsUnanswered: state.alertsSinceAck },
  });
}

async function evaluateTrigger(w: EleanorWatchInstruction, c: Ctx): Promise<void> {
  if (!w.symbol || !w.triggerCondition) return;
  let cond: { op: ">=" | "<="; price: number };
  try { cond = JSON.parse(w.triggerCondition); } catch { return; }
  const px = await ownBridgePriceOf(w.symbol, c.bridge);
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
  const permRevoked = eleanorWatchPermissionBlock(w.kind, c.settings);
  if (permRevoked) {
    if (await markSkipped(w.id, permRevoked)) c.out.skipped.push({ watchId: w.id, reason: permRevoked });
    await deliver({
      userId: c.userId, type: "TRADE", severity: "HIGH", sourceBuild: "LL", dedupeKey: `ELEANOR:WATCH:${w.id}:NOT_AUTHORIZED`,
      title: `${w.symbol}: watch triggered but ${c.assistantName} is not allowed to act`,
      message: `Your ${w.symbol} watch reached ${cond.price} but ${c.assistantName} is no longer permitted to ${w.kind === "WATCH_AND_ENTER" ? "open" : "close"} for you (${permRevoked}). Nothing was sent; the watch has ended.`,
      symbol: w.symbol, actionRequired: true, metadata: { watchId: w.id, reason: permRevoked },
    });
    return;
  }

  let intent: InstantTradeIntent;
  let commandKind: EleanorCommandKind;
  if (w.kind === "WATCH_AND_ENTER") {
    if (typeof w.lot !== "number" || !(w.lot > 0)) {
      if (await markSkipped(w.id, "MISSING_VOLUME")) c.out.skipped.push({ watchId: w.id, reason: "MISSING_VOLUME" });
      return;
    }
    intent = {
      source: w.source as InstantTradeIntent["source"], action: w.side === "SELL" ? "SELL" : "BUY",
      accountMode: "live", symbol: w.symbol,
      volume: w.lot, aiCommand: true, parsedByEleanor: true,
      rawUserCommand: w.rawUserCommand, eleanorCommandKind: "OPEN",
    };
    commandKind = "OPEN_TRADE";
  } else {
    const found = await findWatchedPosition(c.userId, w, c.nowMs);
    if (found.kind === "GONE") {
      if (await markSkipped(w.id, "POSITION_GONE")) c.out.skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
      return;
    }
    if (found.kind === "STALE") { c.out.skipped.push({ watchId: w.id, reason: "POSITION_STALE" }); return; }
    intent = {
      source: w.source as InstantTradeIntent["source"], action: "CLOSE",
      accountMode: "live", symbol: w.symbol,
      positionId: found.p.row.brokerTicket, aiCommand: true, parsedByEleanor: true,
      rawUserCommand: w.rawUserCommand, eleanorCommandKind: "CLOSE",
    };
    commandKind = "CLOSE_TRADE";
  }
  if (!(await claimFire(w.id))) return;
  let ok = false;
  let blocked: string | null = null;
  let commandId: string | undefined;
  try {
    const ledger = await recordAndExecuteEleanor({
      userId: c.userId, intent, commandKind, symbol: w.symbol,
      rawText: w.rawUserCommand ?? `[watch ${w.id}]`, ip: c.opts.ip ?? null, ua: c.opts.ua ?? null,
      params: { watchId: w.id, trigger: cond, firedPrice: px },
    });
    if (ledger.duplicate) {
      // Never re-arm a one-shot watch: a matching command is already in flight.
      await endFired(w.id, "DUPLICATE_PREVENTED");
      c.out.skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" });
      return;
    }
    ok = ledger.result.ok;
    blocked = blockedReason(ledger);
    commandId = ledger.result.ok ? ledger.result.commandId : undefined;
  } catch (err) {
    blocked = `DISPATCH_ERROR: ${(err as Error).message ?? err}`.slice(0, 200);
  }
  if (blocked) {
    // A one-shot watch is not retried at a later, different price.
    await endFired(w.id, `DISPATCH_BLOCKED: ${blocked}`);
  } else {
    await db.update(eleanorWatchInstructionsTable)
      .set({ firedCommandId: commandId ?? null, updatedAt: new Date() })
      .where(eq(eleanorWatchInstructionsTable.id, w.id));
  }
  c.out.fired.push({ watchId: w.id, kind: w.kind, commandId, blocked: blocked ?? undefined });
  await audit(c.userId, "ELEANOR_WATCH_FIRED", { watchId: w.id, kind: w.kind, symbol: w.symbol, trigger: cond, firedPrice: px, ok, blocked }, c.opts);
  await deliver({
    userId: c.userId, type: "TRADE", severity: ok ? "HIGH" : "CRITICAL", sourceBuild: "LL",
    dedupeKey: `ELEANOR:WATCH:${w.id}:FIRED`,
    title: `${w.symbol}: watch triggered at ${px}`,
    message: ok
      ? `${c.assistantName} sent your ${intent.action.toLowerCase()} ${w.symbol} to the broker at ${px} (trigger ${cond.op} ${cond.price}). The fill is confirmed by the broker, not by this message.`
      : `${c.assistantName}'s ${intent.action.toLowerCase()} ${w.symbol} at ${px} did not go through: ${blocked}. Nothing is armed any more; please act yourself if you still want this trade.`,
    symbol: w.symbol, actionRequired: !ok,
    metadata: { watchId: w.id, kind: w.kind, commandId: commandId ?? null },
  });
}

/**
 * The trader answered a reversal alert. "keep" resets the unanswered count and
 * keeps monitoring; "close" fires the close now through the same gated path
 * (the trader's own decision, so the extra-confirmation setting does not apply:
 * the alert was the question).
 */
export async function acknowledgeEleanorWatch(userId: number, watchId: number, decision: "keep" | "close", opts: EvaluateOptions): Promise<
  | { ok: false; error: MonitorMutationError }
  | { ok: true; decision: "keep"; alertsSinceAck: number }
  | { ok: true; decision: "close"; result: EvaluateResult }
> {
  const nowMs = opts.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  if (decision === "keep") {
    const r = await mutateMonitorState(userId, watchId, (s) => acknowledgeKeep(s, at));
    if (!r.ok) return r;
    await audit(userId, "ELEANOR_MONITOR_ALERT_ACK_KEEP", { watchId, symbol: r.watch.symbol, keepCount: r.state.keepCount }, opts);
    return { ok: true, decision: "keep", alertsSinceAck: r.state.alertsSinceAck };
  }
  const [w] = await db.select().from(eleanorWatchInstructionsTable)
    .where(and(eq(eleanorWatchInstructionsTable.id, watchId), eq(eleanorWatchInstructionsTable.userId, userId))).limit(1);
  if (!w) return { ok: false, error: "WATCH_NOT_FOUND" };
  if (w.status !== "ACTIVE") return { ok: false, error: "WATCH_NOT_ACTIVE" };
  if (w.kind !== "MONITOR_TRADE") return { ok: false, error: "NOT_A_MONITOR" };
  return runWithFeedScope(feedScopeForUser(userId, lookupActiveBridge), async () => {
    const out: EvaluateResult = { evaluated: 1, fired: [], alerted: [], adjusted: [], skipped: [] };
    const [settings] = await db.select().from(userOneClickSettingsTable).where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
    const authority = (settings?.eleanorExecutionAuthority ?? "OFF").trim().toUpperCase();
    const bridge = await currentFeedScopeBridge();
    const assistantName = await getAssistantDisplayName(userId);
    const ctx: Ctx = { userId, settings, authority, assistantName, nowMs, opts, out, bridge };
    const rows = w.symbol ? await readOpenPositions({ userId, venue: "LIVE", basis: "CONFIRMED_OPEN", symbol: w.symbol }) : [];
    const p = w.positionTicket ? rows.find((o) => o.row.brokerTicket === w.positionTicket) : (rows.length === 1 ? rows[0] : undefined);
    if (!p) {
      if (await markEnded(w.id, "EXPIRED", "POSITION_CLOSED")) out.skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
      return { ok: true, decision: "close", result: out };
    }
    const revoked = eleanorWatchPermissionBlock("MONITOR_TRADE", settings);
    if (revoked) {
      // The trader asked for a close Eleanor may not send: say so, keep monitoring.
      out.skipped.push({ watchId: w.id, reason: revoked });
      return { ok: true, decision: "close", result: out };
    }
    const px = w.symbol ? await ownBridgePriceOf(w.symbol, bridge) : null;
    // A user-ordered close is not held back by the backoff of an automatic one.
    const state = { ...parseMonitorState(w.riskParams), nextCloseAttemptAt: null };
    await fireClose(w, ctx, { positionId: p.row.brokerTicket, executive: false, expectedRaw: w.riskParams ?? null, state, params: { reason: "you asked me to close after a reversal alert", firedPrice: px, userDecision: true } });
    return { ok: true, decision: "close", result: out };
  });
}

/** Read-only view of a user's watches for the chat panel and the assistant tool. */
export async function listEleanorWatches(userId: number, opts: { includeFinished?: boolean; limit?: number } = {}) {
  const rows = await db.select().from(eleanorWatchInstructionsTable)
    .where(eq(eleanorWatchInstructionsTable.userId, userId));
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
        fakeoutAuthority: m.fakeoutAuthority,
        fakeoutAdjustments: m.fakeoutAdjustments.filter((r) => r.ok).length,
        lastFakeoutAdjustment: m.fakeoutAdjustments.at(-1) ?? null,
      } : null,
    };
  });
}

/**
 * The trader grants or withdraws Eleanor's authority to shift SL/TP on a fakeout
 * for ONE monitor. Stored in the watch row's risk_params (no schema change).
 * Granting here does not bypass the user-level permission: the evaluator still
 * requires AI_ASSISTED + allowEleanorModifyCommands at fire time.
 */
export async function setEleanorWatchFakeoutAuthority(userId: number, watchId: number, enabled: boolean): Promise<
  | { ok: false; error: MonitorMutationError }
  | { ok: true; watchId: number; fakeoutAuthority: boolean }
> {
  const r = await mutateMonitorState(userId, watchId, (s) => setFakeoutAuthority(s, enabled));
  if (!r.ok) return r;
  return { ok: true, watchId, fakeoutAuthority: enabled };
}
