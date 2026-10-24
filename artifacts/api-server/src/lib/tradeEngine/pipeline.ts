// Trade Engine — the one execution pipeline (Tier 1). LIVE, DEMO and PAPER
// are MODES of it, not separate execution paths.
//
//   submitTrade({ mode, intent: OPEN | CLOSE | MODIFY, ... })
//
//   LIVE  OPEN          → liveCommandPipeline createLiveDraft → confirm → dispatch
//                         (per-user arming, kill switch, the Risk Governor and
//                         the dispatch gates; Phase B is the only live writer)
//   DEMO  OPEN          → demoCommandQueue createDraftCommand → confirm →
//                         dispatch (the Risk Governor runs when consumed)
//   LIVE/DEMO CLOSE,
//   MODIFY              → lib/positions/governedOps on the trader's own
//                         ARX-governed position (opened outside ARX → refused)
//   PAPER OPEN / CLOSE /
//   MODIFY              → lib/tradeEngine/paperVenue (paper simulator book,
//                         the Risk Governor with venue PAPER)
//
// Staged contract (LIVE / DEMO): for flows that draft now and confirm or
// dispatch later (often from a separate request), or that must hold a lock
// or write attribution between the steps:
//
//   draftTrade({ mode: "LIVE", kind: "ENTRY" }, input) → createLiveDraft
//   draftTrade({ mode: "LIVE", kind: "OPS" }, input)   → createLiveOpsDraft
//                                                         (close / modify a ticket)
//   draftTrade({ mode: "DEMO" }, input)                → createDraftCommand
//   confirmTrade({ mode }, args)   → confirmLiveCommand | confirmCommand
//   dispatchTrade({ mode }, args)  → dispatchLiveCommand | dispatchApprovedCommand
//
// Each staged call passes the caller's input object to the venue queue
// unchanged and returns the queue's own result unchanged (same type, same
// refusal reasons), so a producer moved onto it behaves exactly as before.
//
// This module adds no gate and removes none: each mode delegates to the
// governed path that already existed, and every refusal is returned as-is.
// It never writes a table itself. scripts/src/ci/check-trade-engine-single-
// pipeline.ts fails on any runtime file that calls a venue queue directly
// without being a listed producer.

import type { GovernedPosition } from "../positions/governedOps.js";
import type { PaperOrderRow } from "./paperVenue.js";
import type * as LiveQueue from "../live/liveCommandPipeline.js";
import type * as DemoQueue from "../mt5/demoCommandQueue.js";

export const TRADE_MODES = ["LIVE", "DEMO", "PAPER"] as const;
export type TradeMode = (typeof TRADE_MODES)[number];
export type BrokerMode = Exclude<TradeMode, "PAPER">;
export type TradeIntent = "OPEN" | "CLOSE" | "MODIFY";
export type Side = "BUY" | "SELL";

/** A broker position: a ticket to resolve (optionally a partial size), or one already resolved by governedOps. */
export type BrokerTarget = { ticket: string; lots?: number | null } | { position: GovernedPosition };

export interface BrokerOpen {
  mode: BrokerMode; intent: "OPEN"; userId: number;
  symbol: string; side: Side; lots: number;
  /** A pending order's type (e.g. BUY_LIMIT) and price; omitted → market order. */
  pending?: { orderType: string; price: number } | null;
  /** LIVE only: the venue order type for a market order (defaults from side). */
  orderType?: string | null;
  stopLoss: number | null; takeProfit: number | null;
  sourcePage: string;
}
export interface BrokerClose { mode: BrokerMode; intent: "CLOSE"; userId: number; target: BrokerTarget; sourcePage: string }
export interface BrokerModify {
  mode: BrokerMode; intent: "MODIFY"; userId: number; target: BrokerTarget;
  /** The full new protection: null removes (the Risk Governor decides whether it may). */
  stopLoss: number | null; takeProfit: number | null;
  sourcePage: string;
}

export interface PaperOpen {
  mode: "PAPER"; intent: "OPEN"; userId: number;
  paperAccountId: number; symbol: string; side: Side; lots: number;
  orderType: "MARKET" | "LIMIT"; entryPrice: number | null;
  stopLoss: number; takeProfit: number;
  strategyId?: string | null; tradePlanId?: number | null; decisionId?: number | null;
  sourcePage: string;
}
export interface PaperClose { mode: "PAPER"; intent: "CLOSE"; userId: number; orderId: number; sourcePage: string }
export interface PaperModify {
  mode: "PAPER"; intent: "MODIFY"; userId: number; orderId: number;
  /** An omitted field keeps the order's current value. */
  stopLoss?: number | null; takeProfit?: number | null;
  sourcePage: string;
}

export type TradeRequest = BrokerOpen | BrokerClose | BrokerModify | PaperOpen | PaperClose | PaperModify;

export type TradeResult =
  | { ok: true; mode: TradeMode; intent: TradeIntent; commandId: string | null; sent: boolean;
      /** The broker position the op acted on (CLOSE / MODIFY on LIVE or DEMO). */
      position?: GovernedPosition; paperOrder?: PaperOrderRow | null }
  | { ok: false; mode: TradeMode; intent: TradeIntent; commandId: string | null; reason: string;
      /** PAPER Risk Governor refusals and geometry refusals carry their detail. */
      detail?: { primaryReason?: string | null; blockedBy?: string[]; auditEventId?: number | null; entryPrice?: number } };

/** The one entry: dispatch a trade request to its mode's governed path. */
export async function submitTrade(req: TradeRequest): Promise<TradeResult> {
  if (!(TRADE_MODES as readonly string[]).includes(req.mode)) {
    return { ok: false, mode: req.mode, intent: req.intent, commandId: null, reason: "UNKNOWN_TRADE_MODE" };
  }
  if (req.mode === "PAPER") return submitPaper(req);
  switch (req.intent) {
    case "OPEN": return req.mode === "DEMO" ? openDemo(req) : openLive(req);
    case "CLOSE":
    case "MODIFY": return submitPositionOp(req);
  }
}

// ── Staged contract (LIVE / DEMO) ─────────────────────────────────────────
type LiveEntryDraftInput = Parameters<typeof LiveQueue.createLiveDraft>[0];
type LiveOpsDraftInput = Parameters<typeof LiveQueue.createLiveOpsDraft>[0];
type DemoDraftInput = Parameters<typeof DemoQueue.createDraftCommand>[0];
type LiveStepArgs = Parameters<typeof LiveQueue.confirmLiveCommand>[0];
type DemoConfirmArgs = Parameters<typeof DemoQueue.confirmCommand>[0];
type DemoDispatchArgs = Parameters<typeof DemoQueue.dispatchApprovedCommand>[0];

/** Which staged venue step a request is for. */
export type StagedDraftStage = { mode: "LIVE"; kind: "ENTRY" | "OPS" } | { mode: "DEMO" };
export type StagedStepStage = { mode: BrokerMode };

const unknownStage = () => ({ ok: false as const, reason: "UNKNOWN_TRADE_MODE" });

/**
 * Staged draft: LIVE ENTRY → createLiveDraft, LIVE OPS → createLiveOpsDraft,
 * DEMO → createDraftCommand. Input and result pass through unchanged.
 */
export function draftTrade(stage: { mode: "LIVE"; kind: "ENTRY" }, input: LiveEntryDraftInput): ReturnType<typeof LiveQueue.createLiveDraft>;
export function draftTrade(stage: { mode: "LIVE"; kind: "OPS" }, input: LiveOpsDraftInput): ReturnType<typeof LiveQueue.createLiveOpsDraft>;
export function draftTrade(stage: { mode: "DEMO" }, input: DemoDraftInput): ReturnType<typeof DemoQueue.createDraftCommand>;
export async function draftTrade(stage: StagedDraftStage, input: unknown): Promise<unknown> {
  if (stage.mode === "LIVE") {
    const live = await import("../live/liveCommandPipeline.js");
    if (stage.kind === "ENTRY") return live.createLiveDraft(input as LiveEntryDraftInput);
    if (stage.kind === "OPS") return live.createLiveOpsDraft(input as LiveOpsDraftInput);
    return unknownStage();
  }
  if (stage.mode === "DEMO") {
    const queue = await import("../mt5/demoCommandQueue.js");
    return queue.createDraftCommand(input as DemoDraftInput);
  }
  return unknownStage();
}

/** Staged confirm: LIVE → confirmLiveCommand, DEMO → confirmCommand. */
export function confirmTrade(stage: { mode: "LIVE" }, args: LiveStepArgs): ReturnType<typeof LiveQueue.confirmLiveCommand>;
export function confirmTrade(stage: { mode: "DEMO" }, args: DemoConfirmArgs): ReturnType<typeof DemoQueue.confirmCommand>;
export async function confirmTrade(stage: StagedStepStage, args: LiveStepArgs | DemoConfirmArgs): Promise<unknown> {
  if (stage.mode === "LIVE") {
    const live = await import("../live/liveCommandPipeline.js");
    return live.confirmLiveCommand(args as LiveStepArgs);
  }
  if (stage.mode === "DEMO") {
    const queue = await import("../mt5/demoCommandQueue.js");
    return queue.confirmCommand(args as DemoConfirmArgs);
  }
  return unknownStage();
}

/**
 * Staged dispatch: LIVE → dispatchLiveCommand (every Phase B gate),
 * DEMO → dispatchApprovedCommand (per-user demo gate, Risk Governor at consume).
 */
export function dispatchTrade(stage: { mode: "LIVE" }, args: LiveStepArgs): ReturnType<typeof LiveQueue.dispatchLiveCommand>;
export function dispatchTrade(stage: { mode: "DEMO" }, args: DemoDispatchArgs): ReturnType<typeof DemoQueue.dispatchApprovedCommand>;
export async function dispatchTrade(stage: StagedStepStage, args: LiveStepArgs | DemoDispatchArgs): Promise<unknown> {
  if (stage.mode === "LIVE") {
    const live = await import("../live/liveCommandPipeline.js");
    return live.dispatchLiveCommand(args as LiveStepArgs);
  }
  if (stage.mode === "DEMO") {
    const queue = await import("../mt5/demoCommandQueue.js");
    return queue.dispatchApprovedCommand(args as DemoDispatchArgs);
  }
  return unknownStage();
}

// ── DEMO ──────────────────────────────────────────────────────────────────
async function openDemo(r: BrokerOpen): Promise<TradeResult> {
  const fail = (commandId: string | null, reason: string): TradeResult =>
    ({ ok: false, mode: "DEMO", intent: "OPEN", commandId, reason });
  const queue = await import("../mt5/demoCommandQueue.js");
  const draft = await queue.createDraftCommand({
    userId: r.userId, commandType: r.pending ? "PLACE_PENDING_ORDER" : "PLACE_MARKET_ORDER",
    payload: {
      symbol: r.symbol, side: r.side, lotSize: r.lots, stopLoss: r.stopLoss, takeProfit: r.takeProfit,
      sourcePage: r.sourcePage,
      ...(r.pending ? { orderType: r.pending.orderType, price: r.pending.price } : {}),
    },
  });
  if (!draft.ok || !draft.command) return fail(null, draft.reason ?? "DRAFT_REFUSED");
  const commandId = draft.command.commandId;
  const confirmed = await queue.confirmCommand({ userId: r.userId, commandId });
  if (!confirmed.ok) return fail(commandId, confirmed.reason ?? "CONFIRM_REFUSED");
  if (confirmed.command?.status === "SENT_TO_MT5_DEMO") return { ok: true, mode: "DEMO", intent: "OPEN", commandId, sent: true };
  const sent = await queue.dispatchApprovedCommand({ userId: r.userId, commandId });
  return sent.ok && sent.command?.status === "SENT_TO_MT5_DEMO"
    ? { ok: true, mode: "DEMO", intent: "OPEN", commandId, sent: true }
    : fail(commandId, sent.reason ?? sent.command?.status ?? "DISPATCH_REFUSED");
}

// ── LIVE ──────────────────────────────────────────────────────────────────
async function openLive(r: BrokerOpen): Promise<TradeResult> {
  const fail = (commandId: string | null, reason: string): TradeResult =>
    ({ ok: false, mode: "LIVE", intent: "OPEN", commandId, reason });
  const pipe = await import("../live/liveCommandPipeline.js");
  const draft = await pipe.createLiveDraft({
    userId: r.userId,
    commandType: r.pending ? "PLACE_LIVE_PENDING_ORDER" : "PLACE_LIVE_MARKET_ORDER",
    symbol: r.symbol, side: r.side,
    orderType: r.pending?.orderType ?? r.orderType ?? (r.side === "SELL" ? "MARKET_SELL" : "MARKET_BUY"),
    requestedVolume: r.lots,
    stopLoss: r.stopLoss, takeProfit: r.takeProfit,
    sourcePage: r.sourcePage,
    payload: r.pending ? { price: r.pending.price } : {},
  });
  if (!draft.ok) return fail(null, draft.reason);
  const commandId = draft.command.commandId;
  const confirmed = await pipe.confirmLiveCommand({ userId: r.userId, commandId });
  if (!confirmed.ok) return fail(commandId, confirmed.reason);
  const sent = await pipe.dispatchLiveCommand({ userId: r.userId, commandId });
  const status = (sent as { command?: { status?: string } }).command?.status ?? null;
  return sent.ok && status !== "LIVE_BLOCKED"
    ? { ok: true, mode: "LIVE", intent: "OPEN", commandId, sent: true }
    : fail(commandId, (sent as { reason?: string }).reason ?? status ?? "DISPATCH_REFUSED");
}

// ── LIVE / DEMO position operations ───────────────────────────────────────
async function submitPositionOp(r: BrokerClose | BrokerModify): Promise<TradeResult> {
  const fail = (reason: string, commandId: string | null = null): TradeResult =>
    ({ ok: false, mode: r.mode, intent: r.intent, commandId, reason });
  const ops = await import("../positions/governedOps.js");
  const pos = "position" in r.target
    ? r.target.position
    : await ops.findGovernedPosition(r.userId, r.target.ticket, r.target.lots ?? null);
  if (!pos) return fail("NOT_AN_ARX_GOVERNED_POSITION");
  if (pos.venue !== r.mode) return fail(`POSITION_IS_${pos.venue}`);
  const op = r.intent === "CLOSE"
    ? await ops.submitGovernedClose(r.userId, pos, r.sourcePage)
    : await ops.submitGovernedModify(r.userId, pos, r.stopLoss, r.takeProfit, r.sourcePage);
  return op.ok
    ? { ok: true, mode: r.mode, intent: r.intent, commandId: op.commandId, sent: true, position: pos }
    : fail(op.reason ?? "REFUSED", op.commandId);
}

// ── PAPER ─────────────────────────────────────────────────────────────────
async function submitPaper(r: PaperOpen | PaperClose | PaperModify): Promise<TradeResult> {
  const venue = await import("./paperVenue.js");
  const res = r.intent === "OPEN"
    ? await venue.openPaperOrder({
      userId: r.userId, paperAccountId: r.paperAccountId, symbol: r.symbol, side: r.side,
      orderType: r.orderType, lots: r.lots, entryPrice: r.entryPrice,
      stopLoss: r.stopLoss, takeProfit: r.takeProfit,
      strategyId: r.strategyId ?? null, tradePlanId: r.tradePlanId ?? null, decisionId: r.decisionId ?? null,
      caller: r.sourcePage,
    })
    : r.intent === "MODIFY"
      ? await venue.modifyPaperOrder({ userId: r.userId, orderId: r.orderId, stopLoss: r.stopLoss, takeProfit: r.takeProfit, caller: r.sourcePage })
      : await venue.closePaperOrder({ userId: r.userId, orderId: r.orderId, caller: r.sourcePage });
  if (res.ok) return { ok: true, mode: "PAPER", intent: r.intent, commandId: null, sent: false, paperOrder: res.order };
  const detail = res.reason === "RISK_GOVERNOR_BLOCK"
    ? { primaryReason: res.primaryReason, blockedBy: res.blockedBy, auditEventId: res.auditEventId }
    : res.reason === "INVALID_SLTP_GEOMETRY" && res.entryPrice !== undefined ? { entryPrice: res.entryPrice } : undefined;
  return { ok: false, mode: "PAPER", intent: r.intent, commandId: null, reason: res.reason, ...(detail ? { detail } : {}) };
}
