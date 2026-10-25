// Governed position operations — the one way to move a stop, change a target
// or close an open position (Tier 1 finalization, item 3).
//
// A stop edit or close on an ARX-governed position goes through the venue's
// own governed queue: LIVE through liveCommandPipeline (draft → confirm →
// dispatch: user arming, kill switch, the Risk Governor, the 18 dispatch
// gates), DEMO through demoCommandQueue (draft → confirm → dispatch, the same
// Risk Governor). The origin follows `sourcePage` (POSITION_GUARDIAN →
// automation, which may only tighten; a page → manual). Nobody writes the
// position ledger to "move" a stop or "close" a position: the broker result
// and the next position snapshot do that.

import { and, desc, eq, inArray } from "drizzle-orm";
import { arxLiveCommandsTable, db, mt5DemoCommandsTable } from "@workspace/db";

export type GovernedVenue = "DEMO" | "LIVE";

export interface GovernedPosition {
  venue: GovernedVenue;
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
}

export interface GovernedOpResult { ok: boolean; commandId: string | null; reason: string | null }

const LIVE_OPEN_TYPES = ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"];
const LIVE_EXPOSED = ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_CANCELLED"];
const DEMO_OPEN_TYPES = ["PLACE_MARKET_ORDER", "PLACE_PENDING_ORDER"];

const sideOf = (v: unknown): "BUY" | "SELL" | null => {
  const s = String(v ?? "").toUpperCase();
  return s === "BUY" || s === "SELL" ? s : null;
};

/** The trader's own ARX-governed entry for this broker ticket, or null (opened outside ARX). */
export async function findGovernedPosition(userId: number, ticket: string, lots?: number | null): Promise<GovernedPosition | null> {
  const [live] = await db.select().from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.userId, userId), eq(arxLiveCommandsTable.brokerTicket, ticket),
    inArray(arxLiveCommandsTable.status, LIVE_EXPOSED), inArray(arxLiveCommandsTable.commandType, LIVE_OPEN_TYPES),
  )).orderBy(desc(arxLiveCommandsTable.id)).limit(1);
  const liveSide = sideOf(live?.side);
  if (live && liveSide) {
    return { venue: "LIVE", ticket, symbol: live.symbol, side: liveSide, lots: lots ?? Number(live.executedVolume ?? live.requestedVolume) };
  }
  const [demo] = await db.select().from(mt5DemoCommandsTable).where(and(
    eq(mt5DemoCommandsTable.userId, userId), eq(mt5DemoCommandsTable.brokerTicket, ticket),
    eq(mt5DemoCommandsTable.status, "FILLED_DEMO"), inArray(mt5DemoCommandsTable.commandType, DEMO_OPEN_TYPES),
  )).orderBy(desc(mt5DemoCommandsTable.id)).limit(1);
  const p = (demo?.payload ?? {}) as Record<string, unknown>;
  const demoSide = sideOf(p["side"]);
  if (demo && demoSide) {
    return { venue: "DEMO", ticket, symbol: String(p["symbol"] ?? ""), side: demoSide, lots: lots ?? demo.fillVolume ?? Number(p["lotSize"] ?? 0) };
  }
  return null;
}

/** Move the stop and/or target of a governed position through its venue's queue. */
export async function submitGovernedModify(userId: number, pos: GovernedPosition,
  stopLoss: number | null, takeProfit: number | null, sourcePage: string): Promise<GovernedOpResult> {
  if (pos.venue === "LIVE") {
    const pipe = await import("../live/liveCommandPipeline.js");
    const draft = await pipe.createLiveOpsDraft({
      userId, commandType: "MODIFY_LIVE_SLTP", brokerTicket: pos.ticket, symbol: pos.symbol, side: pos.side,
      volume: pos.lots, newStopLoss: stopLoss, newTakeProfit: takeProfit, sourcePage,
    });
    if (!draft.ok) return { ok: false, commandId: null, reason: draft.reason };
    return confirmAndDispatchLive(userId, draft.command.commandId);
  }
  const queue = await import("../mt5/demoCommandQueue.js");
  const draft = await queue.createDraftCommand({
    userId, commandType: "MODIFY_SLTP",
    payload: { symbol: pos.symbol, side: pos.side, ticket: pos.ticket, lotSize: pos.lots, stopLoss, takeProfit, sourcePage },
  });
  if (!draft.ok || !draft.command) return { ok: false, commandId: null, reason: draft.reason ?? "DRAFT_REFUSED" };
  return confirmAndDispatchDemo(userId, draft.command.commandId);
}

/** Close (all of, or `lots` of) a governed position through its venue's queue. */
export async function submitGovernedClose(userId: number, pos: GovernedPosition, sourcePage: string): Promise<GovernedOpResult> {
  if (pos.venue === "LIVE") {
    const pipe = await import("../live/liveCommandPipeline.js");
    const draft = await pipe.createLiveOpsDraft({
      userId, commandType: "CLOSE_LIVE_POSITION", brokerTicket: pos.ticket, symbol: pos.symbol, side: pos.side,
      volume: pos.lots, sourcePage,
    });
    if (!draft.ok) return { ok: false, commandId: null, reason: draft.reason };
    return confirmAndDispatchLive(userId, draft.command.commandId);
  }
  const queue = await import("../mt5/demoCommandQueue.js");
  const draft = await queue.createDraftCommand({
    userId, commandType: "CLOSE_POSITION",
    payload: { symbol: pos.symbol, side: pos.side, ticket: pos.ticket, lotSize: pos.lots, sourcePage },
  });
  if (!draft.ok || !draft.command) return { ok: false, commandId: null, reason: draft.reason ?? "DRAFT_REFUSED" };
  return confirmAndDispatchDemo(userId, draft.command.commandId);
}

async function confirmAndDispatchLive(userId: number, commandId: string): Promise<GovernedOpResult> {
  const pipe = await import("../live/liveCommandPipeline.js");
  const confirmed = await pipe.confirmLiveCommand({ userId, commandId });
  if (!confirmed.ok) return { ok: false, commandId, reason: confirmed.reason };
  const sent = await pipe.dispatchLiveCommand({ userId, commandId });
  const status = (sent as { command?: { status?: string } }).command?.status ?? null;
  return sent.ok && status !== "LIVE_BLOCKED"
    ? { ok: true, commandId, reason: null }
    : { ok: false, commandId, reason: (sent as { reason?: string }).reason ?? status ?? "DISPATCH_REFUSED" };
}

async function confirmAndDispatchDemo(userId: number, commandId: string): Promise<GovernedOpResult> {
  const queue = await import("../mt5/demoCommandQueue.js");
  const confirmed = await queue.confirmCommand({ userId, commandId });
  if (!confirmed.ok) return { ok: false, commandId, reason: confirmed.reason ?? "CONFIRM_REFUSED" };
  if (confirmed.command?.status === "SENT_TO_MT5_DEMO") return { ok: true, commandId, reason: null };
  const sent = await queue.dispatchApprovedCommand({ userId, commandId });
  return sent.ok && sent.command?.status === "SENT_TO_MT5_DEMO"
    ? { ok: true, commandId, reason: null }
    : { ok: false, commandId, reason: sent.reason ?? sent.command?.status ?? "DISPATCH_REFUSED" };
}
