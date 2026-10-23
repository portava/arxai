// Phase 28-MT5-DEMO-ARMING — demo positions snapshot + reconciliation.
//
// GET /api/me/demo-positions-snapshot
//
// Joins the live MT5 positions snapshot (from /api/mt5/sync-positions) with
// the user's recent demo command rows to produce:
//   - openPositions[]   one row per open MT5 position with attempted match
//                       to an ARX command (by broker ticket).
//   - reconciliation    counts so the UI can warn when ARX command history
//                       and MT5 positions disagree.
//
// SAFETY: per-user only. Never returns tokens, hashes, IPs, raw account
// numbers, or safetyGateSnapshot blobs. Read-only.

import { Router, type Request } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  mt5DemoCommandsTable,
  mt5StateTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

type RawPosition = {
  ticket?: number | string | null;
  symbol?: string | null;
  side?: string | null;
  lot?: number | string | null;
  volume?: number | string | null;
  entry?: number | string | null;
  price?: number | string | null;
  currentPrice?: number | string | null;
  profit?: number | string | null;
  sl?: number | string | null;
  tp?: number | string | null;
  openedAt?: string | null;
  openTime?: string | null;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

router.get("/me/demo-positions-snapshot", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }

  // Latest positions snapshot belonging to this user. mt5_state is currently
  // a single-row table; we filter by user_id defensively so user A can never
  // see user B's positions even if the table grows multi-row later.
  const stateRows = await db
    .select()
    .from(mt5StateTable)
    .where(eq(mt5StateTable.userId, userId))
    .orderBy(sql`${mt5StateTable.lastSyncAt} DESC NULLS LAST`)
    .limit(1);
  const state = stateRows[0] ?? null;

  const positionsRaw: RawPosition[] = Array.isArray(state?.positions)
    ? (state!.positions as RawPosition[])
    : [];

  // Recent demo commands for ticket-based matching. 100 is plenty — we only
  // need to match open positions, which are typically a small handful.
  const commandRows = await db
    .select({
      id: mt5DemoCommandsTable.id,
      commandId: mt5DemoCommandsTable.commandId,
      status: mt5DemoCommandsTable.status,
      commandType: mt5DemoCommandsTable.commandType,
      brokerTicket: mt5DemoCommandsTable.brokerTicket,
      brokerOrderId: mt5DemoCommandsTable.brokerOrderId,
      fillPrice: mt5DemoCommandsTable.fillPrice,
      fillVolume: mt5DemoCommandsTable.fillVolume,
      payload: mt5DemoCommandsTable.payload,
      filledAt: mt5DemoCommandsTable.filledAt,
      createdAt: mt5DemoCommandsTable.createdAt,
    })
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, userId))
    .orderBy(desc(mt5DemoCommandsTable.id))
    .limit(100);

  // Ticket -> command index for O(1) match.
  const byTicket = new Map<string, (typeof commandRows)[number]>();
  for (const c of commandRows) {
    const t = c.brokerTicket ?? c.brokerOrderId;
    if (t) byTicket.set(String(t), c);
  }

  const openPositions = positionsRaw.map((p) => {
    const ticket = p.ticket == null ? null : String(p.ticket);
    const matched = ticket ? byTicket.get(ticket) ?? null : null;
    return {
      brokerTicket: ticket,
      symbol: p.symbol ?? null,
      side: p.side ?? null,
      volume: num(p.lot ?? p.volume),
      entryPrice: num(p.entry ?? p.price),
      currentPrice: num(p.currentPrice),
      floatingPnL: num(p.profit),
      stopLoss: num(p.sl),
      takeProfit: num(p.tp),
      openedAt: p.openedAt ?? p.openTime ?? null,
      sourceCommandId: matched?.commandId ?? null,
      matchStatus: matched ? "MATCHED_TO_ARX_COMMAND" : "ORPHAN_MT5_POSITION",
    };
  });

  const filledCommands = commandRows.filter(
    (c) => c.status === "FILLED_DEMO" && !!c.brokerTicket,
  );

  const matchedCount = openPositions.filter(
    (p) => p.matchStatus === "MATCHED_TO_ARX_COMMAND",
  ).length;
  const orphanCount = openPositions.length - matchedCount;

  res.json({
    ok: true,
    safetyMode: "demo_only",
    liveExecutionBlocked: true,
    lastSyncAt: state?.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
    openPositions,
    reconciliation: {
      mt5OpenPositionCount: openPositions.length,
      arxMatchedPositionCount: matchedCount,
      arxOrphanPositionCount: orphanCount,
      filledCommandHistoryCount: filledCommands.length,
      inSync: orphanCount === 0,
    },
  });
});

export default router;
