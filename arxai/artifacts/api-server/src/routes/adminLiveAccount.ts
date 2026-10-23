// Admin-only live account views: master MT5 totals, per-user slot
// summaries, and unassigned positions.
//
// SAFETY:
// - Every route requires role ∈ {ADMIN, OWNER}.
// - Read-only. No writes, no execution, no kill-switch interaction.
// - Master account totals are NEVER exposed outside this router.
// - Unassigned positions = open arx_live_positions whose userId does not
//   match any active allocation. Surfaced only to admins for triage.

import { Router, type Request, type Response } from "express";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { openLiveExposureCondition } from "../lib/live/livePositionExposure.js";
import {
  db,
  arxLivePositionsTable,
  mt5ConnectionTable,
  userSlotAllocationTable,
  arxMasterAccountConfigTable,
} from "@workspace/db";

const router = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return null;
  }
  const role = u.role;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: u.id, role };
}

const HEARTBEAT_LIVE_MS = 20_000;

router.get("/admin/live/master-summary", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const configRows = await db.select().from(arxMasterAccountConfigTable)
    .where(eq(arxMasterAccountConfigTable.isActive, true)).limit(1);
  const config = configRows[0];
  if (!config) {
    res.json({
      configured: false,
      note: "No master MT5 account configured. Insert a row into arx_master_account_config pointing at an mt5_connection.id.",
      readOnly: true,
    });
    return;
  }

  const connRows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, config.masterConnectionId)).limit(1);
  const conn = connRows[0];
  if (!conn) {
    res.json({
      configured: true,
      missing: true,
      note: "Configured master connection not found in mt5_connection.",
      readOnly: true,
    });
    return;
  }

  const lastHeartbeat = conn.lastHeartbeat;
  const heartbeatAgeMs = lastHeartbeat ? Date.now() - new Date(lastHeartbeat).getTime() : null;
  const margin = Number(conn.margin ?? 0);
  const equity = Number(conn.accountEquity ?? 0);

  res.json({
    configured: true,
    label: config.label,
    accountCurrency: conn.accountCurrency ?? "USD",
    balance: Number(conn.accountBalance ?? 0),
    equity,
    margin,
    freeMargin: Number(conn.freeMargin ?? 0),
    marginLevelPercent: margin > 0 ? (equity / margin) * 100 : null,
    leverage: conn.leverage,
    accountNumber: conn.accountNumber,
    brokerName: conn.brokerName,
    serverName: conn.serverName,
    accountType: conn.accountType,
    lastHeartbeat,
    isLive: heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_LIVE_MS,
    isStale: heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_LIVE_MS,
    readOnly: true,
  });
});

router.get("/admin/live/user-slots", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const allocations = await db.select().from(userSlotAllocationTable);

  // One pass over arx_live_positions, group by userId in-memory.
  // Open exposure only (shared truth predicate) — reconciled/closed ghosts
  // excluded from per-user open P/L totals.
  const allOpen = await db.select({
    userId: arxLivePositionsTable.userId,
    floatingPl: arxLivePositionsTable.floatingPl,
  }).from(arxLivePositionsTable).where(openLiveExposureCondition());
  const allClosed = await db.select({
    userId: arxLivePositionsTable.userId,
    floatingPl: arxLivePositionsTable.floatingPl,
  }).from(arxLivePositionsTable).where(isNotNull(arxLivePositionsTable.closedAt));

  const openByUser = new Map<number, { pnl: number; count: number }>();
  for (const r of allOpen) {
    const k = openByUser.get(r.userId) ?? { pnl: 0, count: 0 };
    k.pnl += Number(r.floatingPl ?? 0);
    k.count += 1;
    openByUser.set(r.userId, k);
  }
  const realisedByUser = new Map<number, number>();
  for (const r of allClosed) {
    realisedByUser.set(r.userId, (realisedByUser.get(r.userId) ?? 0) + Number(r.floatingPl ?? 0));
  }

  const users = allocations.map((a) => {
    const realisedPnl = realisedByUser.get(a.userId) ?? 0;
    const openAgg = openByUser.get(a.userId) ?? { pnl: 0, count: 0 };
    const slotBalance = Number(a.allocatedFunds) + realisedPnl;
    const slotEquity = slotBalance + openAgg.pnl;
    return {
      userId: a.userId,
      allocatedFunds: Number(a.allocatedFunds),
      accountCurrency: a.accountCurrency,
      isActive: a.isActive,
      realisedPnl,
      openPnL: openAgg.pnl,
      openPositions: openAgg.count,
      slotBalance,
      slotEquity,
      notes: a.notes,
      updatedAt: a.updatedAt,
    };
  });

  res.json({ users, count: users.length, readOnly: true });
});

router.get("/admin/live/unassigned-positions", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const allocations = await db.select({ userId: userSlotAllocationTable.userId })
    .from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.isActive, true));
  const allocatedIds = new Set(allocations.map((a) => a.userId));

  const positions = await db.select().from(arxLivePositionsTable)
    .where(isNull(arxLivePositionsTable.closedAt));

  const unassigned = positions.filter((p) => !allocatedIds.has(p.userId)).map((p) => ({
    id: p.id,
    brokerTicket: p.brokerTicket,
    userId: p.userId,
    symbol: p.symbol,
    direction: p.side,
    volume: Number(p.volume),
    entryPrice: Number(p.entryPrice),
    currentPrice: p.currentPrice != null ? Number(p.currentPrice) : null,
    floatingPl: p.floatingPl != null ? Number(p.floatingPl) : null,
    openedAt: p.openedAt,
    lastSyncedAt: p.lastSyncedAt,
    label: "Unassigned MT5 Position",
  }));

  res.json({ unassigned, count: unassigned.length, readOnly: true });
});

export default router;
