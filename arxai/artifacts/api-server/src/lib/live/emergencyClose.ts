// Task #31 — Operator emergency-close engine.
//
// SAFETY (inviolable):
// - This module NEVER opens or modifies exposure. It only enqueues
//   CLOSE_LIVE_POSITION commands, and it does so EXCLUSIVELY through the
//   normal live pipeline: createLiveOpsDraft → confirmLiveCommand →
//   dispatchLiveCommand. Every close therefore re-runs the SAME 16-gate
//   evaluator, allocation-freeze pre-gate, kill-switch TOCTOU re-check and
//   idempotency guard that a user-initiated close runs through. There is no
//   parallel/bypass dispatch path and no new trading mode.
// - It introduces NO new EA behaviour. EA v1.27+ already executes
//   CLOSE_LIVE_POSITION; nothing here changes the bridge contract.
// - Resolution of which positions to close is READ-ONLY (arx_live_positions
//   + user_slot_allocation). Ownership is read, never assigned.
// - Callers (admin routes) are responsible for admin/OWNER gating,
//   confirmation phrase, reason capture and the per-batch audit row. This
//   module returns a structured per-ticket outcome the caller audits.

import { db } from "@workspace/db";
import { arxLivePositionsTable, userSlotAllocationTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
} from "./liveCommandPipeline.js";
import type { KillSwitchCloseBypass } from "./killSwitchBypass.js";

export type EmergencyCloseScope =
  | { kind: "ticket"; userId: number; brokerTicket: string }
  | { kind: "user"; userId: number }
  | { kind: "allocation"; allocationId: number }
  | { kind: "all_shared" }
  | { kind: "all" };

export interface CloseAttemptResult {
  userId: number;
  brokerTicket: string;
  symbol: string;
  commandId: string | null;
  outcome: "QUEUED" | "BLOCKED" | "ERROR";
  reason?: string;
}

export interface EmergencyCloseSummary {
  scope: string;
  totalOpenMatched: number;
  queued: number;
  blocked: number;
  errored: number;
  results: CloseAttemptResult[];
}

interface OpenPositionRow {
  userId: number;
  brokerTicket: string;
  symbol: string;
  side: string;
  volume: number;
}

// READ-ONLY resolution of the target open positions for a scope. Never
// writes. Never invents ownership — every row already carries its real
// userId in arx_live_positions.
async function resolveOpenPositions(scope: EmergencyCloseScope): Promise<OpenPositionRow[]> {
  const baseCols = {
    userId: arxLivePositionsTable.userId,
    brokerTicket: arxLivePositionsTable.brokerTicket,
    symbol: arxLivePositionsTable.symbol,
    side: arxLivePositionsTable.side,
    volume: arxLivePositionsTable.volume,
  };
  const open = isNull(arxLivePositionsTable.closedAt);

  if (scope.kind === "ticket") {
    const rows = await db.select(baseCols).from(arxLivePositionsTable)
      .where(and(open, eq(arxLivePositionsTable.userId, scope.userId), eq(arxLivePositionsTable.brokerTicket, scope.brokerTicket)));
    return rows;
  }
  if (scope.kind === "user") {
    const rows = await db.select(baseCols).from(arxLivePositionsTable)
      .where(and(open, eq(arxLivePositionsTable.userId, scope.userId)));
    return rows;
  }
  if (scope.kind === "allocation") {
    // user_slot_allocation is 1:1 with user — the allocation id resolves to a
    // single owning user. Close only that user's open positions.
    const alloc = await db.select({ userId: userSlotAllocationTable.userId })
      .from(userSlotAllocationTable)
      .where(eq(userSlotAllocationTable.id, scope.allocationId)).limit(1);
    const ownerId = alloc[0]?.userId;
    if (ownerId == null) return [];
    const rows = await db.select(baseCols).from(arxLivePositionsTable)
      .where(and(open, eq(arxLivePositionsTable.userId, ownerId)));
    return rows;
  }
  if (scope.kind === "all_shared") {
    // Every user with a shared-master slot allocation. Close all their open
    // positions. We intersect on userId so a position is only ever closed
    // for the user who actually owns it in arx_live_positions.
    const allocUsers = await db.select({ userId: userSlotAllocationTable.userId })
      .from(userSlotAllocationTable);
    const ids = new Set(allocUsers.map((a) => a.userId));
    if (ids.size === 0) return [];
    const rows = await db.select(baseCols).from(arxLivePositionsTable).where(open);
    return rows.filter((r) => ids.has(r.userId));
  }
  // kind === "all" — every open live position at the broker, regardless of
  // routing. This is the hardest stop and is gated hardest at the caller.
  const rows = await db.select(baseCols).from(arxLivePositionsTable).where(open);
  return rows;
}

function side(s: string): "BUY" | "SELL" {
  return String(s).toUpperCase() === "SELL" ? "SELL" : "BUY";
}

// Funnel ONE position through the normal pipeline. Any failure at any stage
// is captured as a structured outcome — never thrown — so a batch close keeps
// going and the caller can audit every ticket's result.
async function closeOne(
  pos: OpenPositionRow,
  sourcePage: string,
  killSwitchBypass?: KillSwitchCloseBypass | null,
): Promise<CloseAttemptResult> {
  const base: Omit<CloseAttemptResult, "outcome" | "reason"> = {
    userId: pos.userId,
    brokerTicket: pos.brokerTicket,
    symbol: pos.symbol,
    commandId: null,
  };
  try {
    const draft = await createLiveOpsDraft({
      userId: pos.userId,
      commandType: "CLOSE_LIVE_POSITION",
      brokerTicket: pos.brokerTicket,
      symbol: pos.symbol,
      side: side(pos.side),
      volume: Number(pos.volume),
      sourcePage,
      // Task #743 Cluster D — narrow, CLOSE-only kill-switch bypass (admin
      // emergency-close only). Null/omitted for every other caller.
      killSwitchCloseBypass: killSwitchBypass ?? null,
    });
    if (!draft.ok) return { ...base, outcome: "BLOCKED", reason: draft.reason };
    const commandId = draft.command.commandId;

    const confirmed = await confirmLiveCommand({ userId: pos.userId, commandId });
    if (!confirmed.ok) return { ...base, commandId, outcome: "BLOCKED", reason: confirmed.reason };

    const dispatched = await dispatchLiveCommand({ userId: pos.userId, commandId });
    if (!dispatched.ok) {
      return { ...base, commandId, outcome: "BLOCKED", reason: dispatched.reason };
    }
    return { ...base, commandId, outcome: "QUEUED" };
  } catch (err) {
    return { ...base, outcome: "ERROR", reason: String(err).slice(0, 200) };
  }
}

/**
 * Resolve a scope to its open positions and enqueue a CLOSE for each through
 * the normal 16-gate live pipeline. Returns a per-ticket summary. Does not
 * audit (the caller writes the batch audit row + per-ticket detail).
 */
export async function runEmergencyClose(
  scope: EmergencyCloseScope,
  sourcePage: string,
  options?: { killSwitchBypass?: KillSwitchCloseBypass | null },
): Promise<EmergencyCloseSummary> {
  const positions = await resolveOpenPositions(scope);
  const results: CloseAttemptResult[] = [];
  for (const pos of positions) {
    results.push(await closeOne(pos, sourcePage, options?.killSwitchBypass ?? null));
  }
  return {
    scope: scope.kind,
    totalOpenMatched: positions.length,
    queued: results.filter((r) => r.outcome === "QUEUED").length,
    blocked: results.filter((r) => r.outcome === "BLOCKED").length,
    errored: results.filter((r) => r.outcome === "ERROR").length,
    results,
  };
}
