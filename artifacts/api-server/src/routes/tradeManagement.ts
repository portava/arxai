// Trade-management actions on rows of the `trades` table.
//
// TRUTH CONTRACT (why this file looks the way it does):
//
//  1. These four mutating actions (breakeven / trail / partial-close / close)
//     are a LOCAL SIMULATION. They write `trades.stopLoss`, `trades.lot`,
//     `trades.status` and `trades.pnl` and nothing else. There is no broker
//     adapter here, no queueMt5CommandWithGate, and no call into the Phase B
//     live command pipeline — so nothing on this path can move a real broker
//     position. Every success message says so in words.
//
//  2. Because of (1) they are REFUSED for rows whose `mode` is LIVE. Silently
//     marking a LIVE row CLOSED_WIN while the broker position keeps running is
//     exactly the "falsely certain" failure the governing invariant forbids:
//     the user would believe they are flat when they are not. The refusal names
//     the surface that can actually act on a live position.
//
//  3. Per-user isolation. `trades.id` is a sequential serial shared across
//     tenants, so every read and every UPDATE is scoped by
//     `and(eq(id), eq(userId, req.authUser.id))` and a foreign or legacy
//     (userId IS NULL) row answers 404, not 403 — ids must not be enumerable.
//     Without this any signed-in trader could close another trader's position
//     and falsify their Realized P/L (trades.pnl feeds /performance/summary
//     and /portfolio/exposure).
import { Router, type Request, type Response } from "express";
import { db, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { evaluateTrade } from "../lib/tradeManagement/tradeManager.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { PNL_FLAG_SIMULATED_CLOSE } from "@workspace/domain/safety-contracts/eaCloseFill";

const router = Router();

const TradeIdParam = z.object({ id: z.coerce.number().int().positive() });
const PartialCloseBodySchema = z.object({
  closePct: z.number().min(1).max(99).optional(),
});

// The one sentence every simulated result carries. Kept as a constant so the
// UI, the tests and the server all quote the same wording.
export const TRADE_MANAGEMENT_SIMULATION_NOTE =
  "Simulated in ARX only — no broker order was sent.";

export const LIVE_ACTION_REFUSAL_CODE = "LIVE_TRADE_ACTION_NOT_AVAILABLE" as const;
export const LIVE_ACTION_REFUSAL_MESSAGE =
  "This trade is marked LIVE. Trade Management is not connected to a broker, " +
  "so closing, trailing, break-even and partial close here would change ARX's " +
  "record without changing your real position. Refused. Manage a live position " +
  "from Live Shared → Open Positions, which routes through the gated live " +
  "command pipeline.";

function parseId(req: Request, res: Response): number | null {
  const r = TradeIdParam.safeParse(req.params);
  if (!r.success) {
    res.status(400).json({ error: "Invalid trade id" });
    return null;
  }
  return r.data.id;
}

// Scoped read. A row belonging to another user — or a legacy row with a NULL
// userId that no one can prove ownership of — is indistinguishable from a
// missing row to the caller.
async function getOwnedTrade(id: number, userId: number) {
  const rows = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.id, id), eq(tradesTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// Every UPDATE repeats the ownership predicate so a row that changed hands (or
// a race) can never be written by the wrong user.
function ownedRow(id: number, userId: number) {
  return and(eq(tradesTable.id, id), eq(tradesTable.userId, userId));
}

function isLiveRow(trade: { mode?: string | null }): boolean {
  return (trade.mode ?? "").toUpperCase() === "LIVE";
}

function refuseLive(res: Response): void {
  res.status(409).json({
    success: false,
    error: LIVE_ACTION_REFUSAL_CODE,
    message: LIVE_ACTION_REFUSAL_MESSAGE,
  });
}

// Resolve the caller's trade or answer for it. Returns null when a response
// has already been sent.
async function resolveOwned(req: Request, res: Response) {
  const id = parseId(req, res);
  if (id == null) return null;
  const userId = req.authUser!.id;
  const trade = await getOwnedTrade(id, userId);
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return null; }
  return { id, userId, trade };
}

router.get("/trade-management/:id/snapshot", requireUser, async (req, res) => {
  const owned = await resolveOwned(req, res);
  if (!owned) return;
  res.json(await evaluateTrade(owned.trade));
});

router.post("/trade-management/:id/breakeven", requireUser, async (req, res) => {
  const owned = await resolveOwned(req, res);
  if (!owned) return;
  const { id, userId, trade } = owned;
  if (isLiveRow(trade)) { refuseLive(res); return; }
  const updated = await db.update(tradesTable)
    .set({ stopLoss: trade.entryPrice }).where(ownedRow(id, userId)).returning();
  const row = requireUpdated(updated, res); if (!row) return;
  res.json({
    success: true,
    simulated: true,
    message: `Stop loss moved to break-even at ${trade.entryPrice}. ${TRADE_MANAGEMENT_SIMULATION_NOTE}`,
    trade: serialiseTrade(row),
  });
});

router.post("/trade-management/:id/trail", requireUser, async (req, res) => {
  const owned = await resolveOwned(req, res);
  if (!owned) return;
  const { id, userId, trade } = owned;
  if (isLiveRow(trade)) { refuseLive(res); return; }
  const snap = await evaluateTrade(trade);
  const newStop = snap.suggestions.trail.newStop ?? trade.stopLoss;
  const updated = await db.update(tradesTable)
    .set({ stopLoss: newStop }).where(ownedRow(id, userId)).returning();
  const row = requireUpdated(updated, res); if (!row) return;
  res.json({
    success: true,
    simulated: true,
    message: `Trailing stop moved to ${newStop.toFixed(5)}. ${TRADE_MANAGEMENT_SIMULATION_NOTE}`,
    trade: serialiseTrade(row),
  });
});

router.post("/trade-management/:id/partial-close", requireUser, async (req, res) => {
  const owned = await resolveOwned(req, res);
  if (!owned) return;
  const { id, userId, trade } = owned;
  if (isLiveRow(trade)) { refuseLive(res); return; }
  const parsed = PartialCloseBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "closePct must be between 1 and 99" }); return; }
  const closePct = parsed.data.closePct ?? 50;
  const newLot = Math.max(0.01, Number((trade.lot * (1 - closePct / 100)).toFixed(2)));
  const updated = await db.update(tradesTable)
    .set({ lot: newLot }).where(ownedRow(id, userId)).returning();
  const row = requireUpdated(updated, res); if (!row) return;
  res.json({
    success: true,
    simulated: true,
    message: `Closed ${closePct}% — lot reduced from ${trade.lot} to ${newLot}. ${TRADE_MANAGEMENT_SIMULATION_NOTE}`,
    trade: serialiseTrade(row),
  });
});

router.post("/trade-management/:id/close", requireUser, async (req, res) => {
  const owned = await resolveOwned(req, res);
  if (!owned) return;
  const { id, userId, trade } = owned;
  // A LIVE row must never be stamped CLOSED here: this handler has no broker
  // seam, so the row would say "closed" while the position stays open at the
  // venue, and the fabricated pnl would flow into the realized-P/L aggregates.
  if (isLiveRow(trade)) { refuseLive(res); return; }

  const snap = await evaluateTrade(trade);
  // Win/loss direction is honest — it is the SIGN of the price move, which
  // needs no contract size. The DOLLAR amount is not: this path has no pip
  // value or quote-currency conversion, so it writes NO pnl and marks the row
  // pnlStatus="UNKNOWN". Every money aggregate (/performance/summary,
  // /performance/daily, /performance/strategy-breakdown, /portfolio/exposure)
  // already excludes UNKNOWN rows and the Trade Logs UI renders
  // "P/L unavailable" for them. A number labelled "(mock)" in its own
  // response must never enter a money aggregate.
  const status: "CLOSED_WIN" | "CLOSED_LOSS" = snap.priceMove >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
  const updated = await db.update(tradesTable).set({
    status,
    pnl: null,
    pnlStatus: "UNKNOWN",
    // Shared constant: the Trade Logs P/L cell reads this exact flag to decide
    // that the row's missing P/L is NOT an EA-age problem, so it must never
    // show the "EA too old — upgrade to v1.28" nudge for a close that had no
    // EA and no broker in it. See @workspace/domain/safety-contracts/eaCloseFill.
    dataQualityFlag: PNL_FLAG_SIMULATED_CLOSE,
    closedAt: new Date(),
    // ownedRow(), not eq(id): the id space is sequential across tenants, so an
    // unscoped update let any signed-in user close a stranger's trade.
  }).where(ownedRow(id, userId)).returning();
  const row = requireUpdated(updated, res); if (!row) return;

  const detail =
    `${trade.symbol} ${trade.direction} closed at ${snap.currentPrice.toFixed(5)} ` +
    `(${snap.priceMove >= 0 ? "+" : ""}${snap.priceMove.toFixed(5)} from entry). ` +
    `P/L unavailable — this simulated close is not priced in account currency.`;

  await createAlert({
    type: "TRADE_CLOSED",
    severity: status === "CLOSED_WIN" ? "success" : "warning",
    title: `Trade closed (${status === "CLOSED_WIN" ? "in profit" : "at a loss"})`,
    message: detail,
    symbol: trade.symbol,
  });

  res.json({
    success: true,
    simulated: true,
    message: detail,
    pnlStatus: "UNKNOWN",
    trade: serialiseTrade(row),
  });
});

// A concurrent update could have moved the row out from under the ownership
// predicate between the read and the write. That is a "we do not know" case,
// not a success — answer 409 rather than report a change we cannot show.
function requireUpdated(
  rows: (typeof tradesTable.$inferSelect)[],
  res: Response,
): typeof tradesTable.$inferSelect | null {
  const row = rows[0];
  if (!row) {
    res.status(409).json({
      success: false,
      error: "TRADE_CHANGED_CONCURRENTLY",
      message: "The trade changed while this action was running. Nothing was applied — reload and try again.",
    });
    return null;
  }
  return row;
}

function serialiseTrade(t: typeof tradesTable.$inferSelect) {
  return {
    ...t,
    createdAt: t.createdAt?.toISOString() ?? new Date().toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}

export default router;
