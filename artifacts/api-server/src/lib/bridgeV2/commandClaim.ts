// ── Bridge v2 command channel — one-time delivery claim ─────────────────────
//
// GET /api/bridge/v2/commands projects SENT_TO_MT5_LIVE rows (egress.ts, a pure
// read). Without a claim every poll re-served the same rows, and the v2 kernel's
// in-memory idempotency is lost on an EA restart. This module stamps the SAME
// pickup marker the other live transports use (`pickedByEaAt`, compare-and-set
// on an unpicked dispatched row) and serves only the rows it won, so a command
// reaches the EA through this channel at most once. It originates nothing,
// changes no lifecycle status, and never reaches the dispatch pipeline: it is
// delivery bookkeeping, and a served command with no result stays held
// (pickup evidence → LIVE_UNKNOWN at TTL, reservation held).

import { db as defaultDb, arxLiveCommandsTable } from "@workspace/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { appendExecutionEvidence } from "../live/executionEvidence.js";
import { logger } from "../logger.js";
import { listBridgeV2CommandsForEa, type BridgeV2EaCommand } from "./egress.js";

export interface BridgeV2ClaimDeps {
  list: typeof listBridgeV2CommandsForEa;
  claim: (args: { userId: number; bridgeConnectionId: number | null; commandIds: string[]; now: Date }) => Promise<{ id: number; commandId: string }[]>;
  recordPickup: (row: { id: number; commandId: string }, bridgeConnectionId: number | null, now: Date) => Promise<void>;
}

const defaultDeps: BridgeV2ClaimDeps = {
  list: listBridgeV2CommandsForEa,
  claim: async ({ userId, bridgeConnectionId, commandIds, now }) =>
    defaultDb.update(arxLiveCommandsTable).set({ pickedByEaAt: now }).where(and(
      inArray(arxLiveCommandsTable.commandId, commandIds),
      eq(arxLiveCommandsTable.userId, userId),
      eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
      isNull(arxLiveCommandsTable.pickedByEaAt),
      bridgeConnectionId == null ? undefined : or(
        eq(arxLiveCommandsTable.bridgeConnectionId, bridgeConnectionId),
        isNull(arxLiveCommandsTable.bridgeConnectionId),
      ),
    )).returning({ id: arxLiveCommandsTable.id, commandId: arxLiveCommandsTable.commandId }),
  recordPickup: async (row, bridgeConnectionId, now) => appendExecutionEvidence({
    commandRowId: row.id, source: "ea", eventType: "EA_PICKED_UP", occurredAt: now,
    payload: { commandId: row.commandId, bridgeConnectionId, transport: "bridge_v2" },
  }),
};

/** Project, then claim; serve only the rows this poll won. */
export async function claimBridgeV2CommandsForEa(
  userId: number,
  bridgeConnectionId: number | null,
  nowMs: number = Date.now(),
  deps: BridgeV2ClaimDeps = defaultDeps,
): Promise<BridgeV2EaCommand[]> {
  const projected = await deps.list(userId, bridgeConnectionId, nowMs);
  if (projected.length === 0) return [];
  const now = new Date(nowMs);
  const won = await deps.claim({ userId, bridgeConnectionId, commandIds: projected.map((c) => c.arxCommandId), now });
  const wonIds = new Set(won.map((r) => r.commandId));
  for (const row of won) {
    // Evidence is best-effort after the claim committed; the stamp itself is
    // the pickup truth the TTL sweep reads.
    try { await deps.recordPickup(row, bridgeConnectionId, now); }
    catch (err) { logger.warn({ err: String(err), commandId: row.commandId }, "bridge_v2_pickup_evidence_failed"); }
  }
  return projected.filter((c) => wonIds.has(c.arxCommandId));
}
