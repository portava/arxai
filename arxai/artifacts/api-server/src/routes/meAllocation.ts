// Per-user allocation view — shows ONLY the caller's own slot.
//
// SAFETY:
// - Strictly per-user. Every query is scoped by req.authUser.id.
// - Never returns master MT5 balance, equity, free margin, or any other
//   user's data. Never returns operator notes, frozenByUserId, raw freeze
//   reasons, or admin-internal fields.
// - The full slot metrics (balance / equity / margin / positions) live at
//   /api/me/live/slot-summary. This endpoint is the lightweight
//   "allocation card" payload — useful for headers and overviews.

import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, userSlotAllocationTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

router.get("/me/allocation", requireUser, async (req, res) => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id;
  if (!userId) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return; }

  const rows = await db.select().from(userSlotAllocationTable)
    .where(eq(userSlotAllocationTable.userId, userId)).limit(1);
  const a = rows[0];
  if (!a) {
    res.json({ ok: true, hasAllocation: false });
    return;
  }

  const total = Number(a.allocatedFunds);
  let manual = Number(a.manualAllocatedFunds);
  let ai = Number(a.aiAllocatedFunds);
  if (manual + ai === 0 && total > 0) manual = total;

  const isFrozen = a.allocationStatus === "frozen" || a.tradingFrozen;
  const freezeMessage = a.allocationStatus === "frozen"
    ? "Your live account has been paused by an operator. Contact support for assistance."
    : a.tradingFrozen
      ? "Trading has been temporarily paused on your account. You can still view your balance and trade history."
      : a.aiTradingFrozen
        ? "AI trading has been paused on your account."
        : null;

  res.json({
    ok: true,
    hasAllocation: true,
    totalAllocation:            total,
    manualAllocationBalance:    manual,
    aiManagedAllocationBalance: ai,
    currency:                   a.accountCurrency,
    allocationStatus:           a.allocationStatus,
    tradingFrozen:              a.tradingFrozen,
    aiTradingFrozen:            a.aiTradingFrozen,
    aiAutoTradingEnabled:       a.aiAutoTradingEnabled,
    aiStrategyMode:             a.aiStrategyMode,
    aiMaxLot:                   a.aiMaxLot != null ? Number(a.aiMaxLot) : null,
    aiMaxDailyLoss:             a.aiMaxDailyLossUsd != null ? Number(a.aiMaxDailyLossUsd) : null,
    isFrozen,
    freezeMessage,
  });
});

export default router;
