// Build H — Live Position Management routes.
//
// COMPOSES:
//   - mt5_state.positions JSONB (broker truth feed, synced via /mt5/sync-positions)
//   - tradesTable           (system-of-record order rows)
//   - mt5_commands          (queues CLOSE / MODIFY for the EA)
//   - vault_events          (truthDomain="POSITION" — emits scoring signals)
//
// ADDS:
//   - live_positions   (mirrored live state for UI / scoring / AI Coach)
//   - position_events  (append-only timeline)
//
// SAFETY RULES (enforced here, not in the evaluator):
//   - REMOVE_STOP_LOSS requires explicit `confirm: true` body field.
//   - MANUAL_CLOSE     requires explicit `confirm: true` body field.
//   - We never auto-modify SL/TP; routes only act when the operator calls.
//   - PER-USER ISOLATION (added in review). Every id-addressed route below is
//     `requireUser` and reads/writes through `and(eq(id), eq(userId, caller))`.
//     `live_positions.id` is a sequential serial shared across tenants, and this
//     router previously resolved rows by id ALONE with no auth middleware at all
//     (routes/index.ts mounts it unconditionally). That was worse than the same
//     bug in tradeManagement.ts, because this file REACHES THE BROKER:
//     PATCH /positions/:id/stop-loss and POST /positions/:id/close call
//     `queueMt5CommandWithGate("MODIFY" | "CLOSE", { ticket: row.brokerPositionId })`,
//     and /close also writes `trades.status` and `trades.pnl`. Any signed-in
//     trader could therefore widen or strip another tenant's stop at the venue,
//     close their position, and falsify their realized P/L by guessing an
//     integer. A foreign row — or a legacy row whose user_id is NULL, which
//     nobody can prove ownership of — answers 404, not 403, so ids stay
//     non-enumerable.
//
//     The one exception is POST /positions/sync. It is not a per-user action:
//     it reconciles the SERVER-WIDE user_id IS NULL mirror against the single
//     legacy MT5 connection's mt5_state feed, and mass-updates those rows. It is
//     ADMIN/OWNER-gated and its response is scoped to the rows it reconciled —
//     it used to return `select().from(live_positions)` with no predicate, i.e.
//     every tenant's open positions to any caller.

import { Router, type Request, type Response, type NextFunction } from "express";
import {
  db,
  livePositionsTable,
  positionEventsTable,
  tradesTable,
  mt5StateTable,
  vaultEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  evaluateLivePosition,
  POSITION_STATUS_TERMINAL,
  type LivePositionStatus,
} from "@workspace/domain/live-position";
import { queueMt5CommandWithGate } from "./mt5";
import { PNL_DATA_QUALITY_MISSING_CLOSE_FILL } from "../lib/live/realizedPnl.js";
import { requireUser } from "../lib/auth/middleware.js";
import { readRoleFromRequest } from "../lib/security/middleware.js";

const router = Router();

// ── per-user isolation ─────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

/** Ownership predicate. Repeated on every UPDATE, never computed once and reused
 *  across a read-then-write window, so a row that changed hands (or a race)
 *  cannot be written by the wrong user. */
function ownedRow(id: number, userId: number) {
  return and(eq(livePositionsTable.id, id), eq(livePositionsTable.userId, userId));
}

/**
 * Resolve `:id` for the calling user, or answer for it. Returns null when a
 * response has already been sent.
 *
 * A foreign row and a legacy user_id IS NULL row are both 404 — identical to a
 * missing row from the caller's side. 403 would confirm the id exists.
 */
async function resolveOwned(
  req: Request,
  res: Response,
): Promise<{ id: number; userId: number; row: typeof livePositionsTable.$inferSelect } | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const userId = req.authUser!.id;
  const rows = await db.select().from(livePositionsTable).where(ownedRow(id, userId)).limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return { id, userId, row };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function loadMt5Positions(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(mt5StateTable).orderBy(asc(mt5StateTable.id)).limit(1);
  const positions = rows[0]?.positions;
  return Array.isArray(positions) ? (positions as Array<Record<string, unknown>>) : [];
}
async function loadAccountEquity(): Promise<number | null> {
  const rows = await db.select().from(mt5StateTable).orderBy(asc(mt5StateTable.id)).limit(1);
  return rows[0]?.equity ?? null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

async function appendEvent(args: {
  livePositionId: number;
  eventType: string;
  severity?: "INFO" | "WARN" | "DANGER";
  message: string;
  oldValue?: unknown;
  newValue?: unknown;
}) {
  await db.insert(positionEventsTable).values({
    livePositionId: args.livePositionId,
    eventType: args.eventType,
    severity: args.severity ?? "INFO",
    message: args.message,
    oldValue: (args.oldValue ?? null) as never,
    newValue: (args.newValue ?? null) as never,
  });
}

async function appendVault(kind: string, severity: "INFO" | "WARN" | "DANGER", livePositionId: number, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind,
    severity,
    source: "SYSTEM",
    truthDomain: "POSITION",
    summary: `${kind}: live_position #${livePositionId}`,
    payload,
    reasons: [],
    blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
}

function serializeLivePosition(row: typeof livePositionsTable.$inferSelect) {
  return {
    id: row.id,
    tradeId: row.tradeId,
    brokerPositionId: row.brokerPositionId,
    symbol: row.symbol,
    direction: row.direction,
    lotSize: row.lotSize,
    entryPrice: row.entryPrice,
    currentPrice: row.currentPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    unrealizedProfitLoss: row.unrealizedProfitLoss,
    realizedProfitLoss: row.realizedProfitLoss,
    rewardToRisk: row.rewardToRisk,
    status: row.status as LivePositionStatus,
    openedAtIso: row.openedAt?.toISOString() ?? null,
    closedAtIso: row.closedAt?.toISOString() ?? null,
    lastSyncedAtIso: row.lastSyncedAt?.toISOString() ?? null,
  };
}

// ── core sync ──────────────────────────────────────────────────────────────

/**
 * Reconcile live_positions against the broker's mt5_state.positions JSONB feed.
 * - Inserts new rows for unseen broker positions.
 * - Updates current_price, uPnL, status, sl/tp on existing rows.
 * - Marks rows CLOSED if they vanish from the feed and were previously OPEN.
 * Returns the post-sync rows + accumulated warnings for the caller.
 */
async function syncFromBroker() {
  const [feed, equity] = await Promise.all([loadMt5Positions(), loadAccountEquity()]);
  // UX9 hardening — this central /positions/sync feed currently inserts rows
  // with user_id=NULL (the single legacy MT5 connection on the server). With
  // the new composite uniqueness on (user_id, broker_position_id), real
  // per-user rows can legitimately share a broker_position_id with these
  // NULL-user rows. Scope the existing-row read to user_id IS NULL so we
  // never read or update a tenant's row by ticket alone.
  const existing = await db.select().from(livePositionsTable)
    .where(isNull(livePositionsTable.userId));
  const byBrokerId = new Map(existing.filter((r) => r.brokerPositionId).map((r) => [r.brokerPositionId!, r]));

  const seenBrokerIds = new Set<string>();
  const symbolDirectionCounts = new Map<string, number>(); // for correlation

  // Pre-pass: count open positions per (symbol, direction).
  for (const p of feed) {
    const sym = String(p["symbol"] ?? "");
    const dir = String(p["side"] ?? p["direction"] ?? "").toUpperCase();
    if (sym && dir) {
      const key = `${sym}:${dir}`;
      symbolDirectionCounts.set(key, (symbolDirectionCounts.get(key) ?? 0) + 1);
    }
  }

  for (const p of feed) {
    const ticket = p["ticket"] != null ? String(p["ticket"]) : null;
    if (!ticket) continue;
    seenBrokerIds.add(ticket);

    const symbol = String(p["symbol"] ?? "");
    const direction = String(p["side"] ?? p["direction"] ?? "BUY").toUpperCase() as "BUY" | "SELL";
    const lotSize = toNum(p["lot"] ?? p["lotSize"] ?? p["volume"]) ?? 0;
    const entryPrice = toNum(p["entry"] ?? p["entryPrice"] ?? p["openPrice"]) ?? 0;
    const currentPrice = toNum(p["price"] ?? p["currentPrice"] ?? p["bid"]);
    const stopLoss = toNum(p["sl"] ?? p["stopLoss"]);
    const takeProfit = toNum(p["tp"] ?? p["takeProfit"]);

    const correlatedOpenCount = Math.max(0, (symbolDirectionCounts.get(`${symbol}:${direction}`) ?? 1) - 1);

    const prev = byBrokerId.get(ticket);
    const stopLossWasRemoved = !!(prev?.stopLoss != null && stopLoss == null);
    const verdict = evaluateLivePosition({
      direction, lotSize, entryPrice, currentPrice, stopLoss, takeProfit,
      correlatedOpenCount, accountEquity: equity, stopLossWasRemoved,
    }, (prev?.status as LivePositionStatus) ?? "SYNC_PENDING");

    if (!prev) {
      // Idempotent insert: unique index on broker_position_id prevents
      // concurrent /positions/sync calls from inserting duplicate rows.
      // ON CONFLICT DO NOTHING — if another sync raced us, returning is empty
      // and we'll pick up the row on the next cycle.
      const inserted = await db.insert(livePositionsTable).values({
        brokerPositionId: ticket,
        symbol, direction, lotSize, entryPrice,
        currentPrice, stopLoss, takeProfit,
        unrealizedProfitLoss: verdict.unrealizedPnL,
        rewardToRisk: verdict.rewardToRisk,
        status: verdict.status,
        openedAt: new Date(),
        lastSyncedAt: new Date(),
      }).onConflictDoNothing({ target: [livePositionsTable.userId, livePositionsTable.brokerPositionId] }).returning();
      const row = inserted[0];
      if (row) {
        await appendEvent({ livePositionId: row.id, eventType: "OPENED",
          severity: "INFO", message: `Opened ${direction} ${symbol} @ ${entryPrice}`,
          newValue: { lotSize, entryPrice, stopLoss, takeProfit } });
        for (const w of verdict.warnings) {
          await appendEvent({ livePositionId: row.id, eventType: "RISK_WARNING",
            severity: w.severity, message: w.message, newValue: { code: w.code } });
        }
      }
      continue;
    }

    // Detect transitions worth logging.
    if (prev.stopLoss !== stopLoss) {
      await appendEvent({ livePositionId: prev.id, eventType: stopLoss == null ? "SL_REMOVED" : "SL_MOVED",
        severity: stopLoss == null ? "DANGER" : "INFO",
        message: stopLoss == null ? "Stop loss removed by broker/EA" : `Stop loss moved ${prev.stopLoss} → ${stopLoss}`,
        oldValue: { stopLoss: prev.stopLoss }, newValue: { stopLoss } });
      if (stopLoss == null) await appendVault("POSITION_SL_REMOVED", "DANGER", prev.id, { tradeId: prev.tradeId });
    }
    if ((prev.status as LivePositionStatus) !== verdict.status) {
      await appendEvent({ livePositionId: prev.id, eventType: verdict.status,
        severity: verdict.status === "STOP_LOSS_HIT" ? "DANGER" : verdict.status === "TAKE_PROFIT_HIT" ? "INFO" : "WARN",
        message: `Status: ${prev.status} → ${verdict.status}`,
        oldValue: { status: prev.status }, newValue: { status: verdict.status } });
      if (verdict.status === "STOP_LOSS_HIT") await appendVault("POSITION_STOP_HIT", "WARN", prev.id, { tradeId: prev.tradeId, currentPrice });
      if (verdict.status === "TAKE_PROFIT_HIT") await appendVault("POSITION_TAKE_HIT", "INFO", prev.id, { tradeId: prev.tradeId, currentPrice });
    }
    for (const w of verdict.warnings) {
      // Only emit a fresh warning event if the previous warning bag didn't have it.
      // Cheap heuristic: emit on every sync where the warning is DANGER, otherwise skip.
      if (w.severity === "DANGER") {
        await appendEvent({ livePositionId: prev.id, eventType: "RISK_WARNING",
          severity: "DANGER", message: w.message, newValue: { code: w.code } });
      }
    }

    await db.update(livePositionsTable).set({
      currentPrice, stopLoss, takeProfit,
      unrealizedProfitLoss: verdict.unrealizedPnL,
      rewardToRisk: verdict.rewardToRisk,
      status: verdict.status,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
      ...(POSITION_STATUS_TERMINAL[verdict.status] && !prev.closedAt ? { closedAt: new Date() } : {}),
    }).where(eq(livePositionsTable.id, prev.id));
  }

  // Anything OPEN-ish that vanished from the feed → MANUALLY_CLOSED.
  const openish = existing.filter((r) =>
    r.brokerPositionId &&
    !seenBrokerIds.has(r.brokerPositionId) &&
    !POSITION_STATUS_TERMINAL[r.status as LivePositionStatus],
  );
  for (const row of openish) {
    await db.update(livePositionsTable).set({
      status: "MANUALLY_CLOSED",
      closedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(livePositionsTable.id, row.id));
    await appendEvent({ livePositionId: row.id, eventType: "MANUAL_CLOSE",
      severity: "WARN", message: "Position vanished from broker feed — treated as manual close",
      oldValue: { status: row.status }, newValue: { status: "MANUALLY_CLOSED" } });
    await appendVault("POSITION_MANUAL_CLOSE", "WARN", row.id, { tradeId: row.tradeId });
  }

  // Return only what this sync actually reconciled — the user_id IS NULL
  // mirror. Unscoped, this returned every tenant's live positions to whoever
  // called /positions/sync.
  const after = await db.select().from(livePositionsTable)
    .where(isNull(livePositionsTable.userId))
    .orderBy(desc(livePositionsTable.updatedAt));
  return after;
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /positions — the CALLER's current open positions (non-terminal statuses)
router.get("/positions", requireUser, async (req, res) => {
  try {
    const all = await db.select().from(livePositionsTable)
      .where(eq(livePositionsTable.userId, req.authUser!.id))
      .orderBy(desc(livePositionsTable.updatedAt));
    const open = all.filter((r) => !POSITION_STATUS_TERMINAL[r.status as LivePositionStatus]);
    res.json({ positions: open.map(serializeLivePosition) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /positions failed");
    res.status(500).json({ error: "Failed to load positions" });
  }
});

// GET /positions/:id
router.get("/positions/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    res.json(serializeLivePosition(owned.row));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /positions/:id failed");
    res.status(500).json({ error: "Failed to load position" });
  }
});

// POST /positions/sync — pull from mt5_state, update live_positions.
// ADMIN/OWNER only: this reconciles the server-wide user_id IS NULL mirror for
// the single legacy MT5 connection, not the caller's own positions.
router.post("/positions/sync", requireUser, requireAdmin, async (req, res) => {
  try {
    const after = await syncFromBroker();
    res.json({ syncedAt: new Date().toISOString(), positions: after.map(serializeLivePosition) });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /positions/sync failed");
    res.status(500).json({ error: "Failed to sync positions" });
  }
});

// PATCH /positions/:id/stop-loss — operator-initiated SL update
const SLBody = z.object({
  stopLoss: z.number().nullable(),
  removeConfirmed: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
router.patch("/positions/:id/stop-loss", requireUser, async (req, res): Promise<void> => {
  try {
    const body = SLBody.parse(req.body ?? {});
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    const { id, userId, row } = owned;

    // Inviolable rule: removing SL requires explicit confirmation.
    if (body.stopLoss == null && !body.removeConfirmed) {
      res.status(409).json({
        error: "Removing the stop loss requires explicit confirmation.",
        blockers: ["pass removeConfirmed:true to remove the stop loss"],
        aiExplanation: "Removing your stop loss is one of the most account-damaging actions you can take. Confirm explicitly if this is truly intentional.",
      });
      return;
    }

    // Queue MODIFY through the shared MT5 gate so mode/live-lock semantics apply.
    if (row.brokerPositionId) {
      await queueMt5CommandWithGate("MODIFY", {
        ticket: Number(row.brokerPositionId) || null,
        sl: body.stopLoss ?? null,
        tp: row.takeProfit ?? null,
      });
    }
    await db.update(livePositionsTable).set({ stopLoss: body.stopLoss, updatedAt: new Date() })
      .where(ownedRow(id, userId));
    await appendEvent({ livePositionId: id,
      eventType: body.stopLoss == null ? "SL_REMOVED" : "SL_MOVED",
      severity: body.stopLoss == null ? "DANGER" : "INFO",
      message: body.stopLoss == null ? "Operator removed stop loss" : `Operator moved SL ${row.stopLoss} → ${body.stopLoss}`,
      oldValue: { stopLoss: row.stopLoss }, newValue: { stopLoss: body.stopLoss } });
    await appendVault(body.stopLoss == null ? "POSITION_SL_REMOVED_BY_USER" : "POSITION_SL_MOVED_BY_USER",
      body.stopLoss == null ? "DANGER" : "INFO", id,
      { tradeId: row.tradeId, oldStopLoss: row.stopLoss, newStopLoss: body.stopLoss, reason: body.reason ?? null });

    const after = await db.select().from(livePositionsTable).where(ownedRow(id, userId)).limit(1);
    res.json(serializeLivePosition(after[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /positions/:id/stop-loss failed");
    res.status(500).json({ error: "Failed to update stop loss" });
  }
});

// PATCH /positions/:id/take-profit
const TPBody = z.object({ takeProfit: z.number().nullable(), reason: z.string().max(500).optional() });
router.patch("/positions/:id/take-profit", requireUser, async (req, res): Promise<void> => {
  try {
    const body = TPBody.parse(req.body ?? {});
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    const { id, userId, row } = owned;

    if (row.brokerPositionId) {
      await queueMt5CommandWithGate("MODIFY", {
        ticket: Number(row.brokerPositionId) || null,
        sl: row.stopLoss ?? null,
        tp: body.takeProfit ?? null,
      });
    }
    await db.update(livePositionsTable).set({ takeProfit: body.takeProfit, updatedAt: new Date() })
      .where(ownedRow(id, userId));
    await appendEvent({ livePositionId: id, eventType: "TP_MOVED", severity: "INFO",
      message: `Operator moved TP ${row.takeProfit} → ${body.takeProfit}`,
      oldValue: { takeProfit: row.takeProfit }, newValue: { takeProfit: body.takeProfit } });

    const after = await db.select().from(livePositionsTable).where(ownedRow(id, userId)).limit(1);
    res.json(serializeLivePosition(after[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /positions/:id/take-profit failed");
    res.status(500).json({ error: "Failed to update take profit" });
  }
});

// POST /positions/:id/close-confirmation — returns a verdict the UI must echo back to /close
router.post("/positions/:id/close-confirmation", requireUser, async (req, res): Promise<void> => {
  try {
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    const { row } = owned;
    if (POSITION_STATUS_TERMINAL[row.status as LivePositionStatus]) {
      res.status(409).json({ error: "Position already terminal", status: row.status });
      return;
    }
    res.json({
      requiresConfirmation: true,
      summary: `Close ${row.direction} ${row.symbol} @ ${row.currentPrice ?? row.entryPrice} (uPnL ${row.unrealizedProfitLoss ?? 0})`,
      blockers: [],
      aiExplanation: "Manual closes lock in current P&L and skip the planned exit. Confirm only if your original setup is truly invalidated.",
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "close-confirmation failed");
    res.status(500).json({ error: "Failed to build close confirmation" });
  }
});

// POST /positions/:id/close — requires confirm:true
const CloseBody = z.object({ confirm: z.literal(true), reason: z.string().max(500).optional() });
router.post("/positions/:id/close", requireUser, async (req, res): Promise<void> => {
  try {
    const body = CloseBody.parse(req.body ?? {});
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    const { id, userId, row } = owned;
    if (POSITION_STATUS_TERMINAL[row.status as LivePositionStatus]) {
      res.status(409).json({ error: "Position already terminal", status: row.status });
      return;
    }

    if (row.brokerPositionId) {
      await queueMt5CommandWithGate("CLOSE", {
        ticket: Number(row.brokerPositionId) || null,
      });
    }
    await db.update(livePositionsTable).set({
      status: "MANUALLY_CLOSED", closedAt: new Date(), updatedAt: new Date(),
    }).where(ownedRow(id, userId));
    // The trade row is reached through a LOOSE FK on the position row, so it
    // gets its own ownership predicate rather than inheriting the position's.
    // `tradeRecordUpdated` reports whether it actually matched: a live_position
    // whose trade row is legacy/unowned must not have its close silently
    // dropped and reported as a clean success.
    let tradeRecordUpdated: boolean | null = null;
    if (row.tradeId) {
      const ownedTrade = and(eq(tradesTable.id, row.tradeId), eq(tradesTable.userId, userId));
      // Derive close result from realized/unrealized PnL — never hardcode loss.
      // If the broker never reported either value, we refuse to invent one:
      // mark pnlStatus="UNKNOWN" + a data-quality flag so Trade Logs renders
      // "P/L unavailable" and analytics aggregates exclude the row.
      const rawPnl = row.realizedProfitLoss ?? row.unrealizedProfitLoss;
      const hasTrustedPnl = typeof rawPnl === "number" && Number.isFinite(rawPnl);
      if (hasTrustedPnl) {
        const tradeStatus = rawPnl >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS";
        const w = await db.update(tradesTable).set({
          status: tradeStatus, pnl: rawPnl, closedAt: new Date(),
          pnlStatus: "COMPUTED", dataQualityFlag: null,
        }).where(ownedTrade).returning({ id: tradesTable.id });
        tradeRecordUpdated = w.length > 0;
      } else {
        const w = await db.update(tradesTable).set({
          status: "CLOSED_LOSS", // status retained as terminal; pnl is null+UNKNOWN
          pnl: null, closedAt: new Date(),
          pnlStatus: "UNKNOWN",
          // Canonical constant from lib/live/realizedPnl — same flag the
          // live-test-cycle uses when the broker close-result didn't carry
          // a usable fill price.
          dataQualityFlag: PNL_DATA_QUALITY_MISSING_CLOSE_FILL,
        }).where(ownedTrade).returning({ id: tradesTable.id });
        tradeRecordUpdated = w.length > 0;
      }
      if (tradeRecordUpdated === false) {
        req.log.warn(
          { livePositionId: id, tradeId: row.tradeId, userId },
          "close: linked trade row is not owned by the caller — trade record left untouched",
        );
      }
    }
    await appendEvent({ livePositionId: id, eventType: "MANUAL_CLOSE", severity: "WARN",
      message: `Operator closed position: ${body.reason ?? "no reason given"}`,
      oldValue: { status: row.status }, newValue: { status: "MANUALLY_CLOSED" } });
    await appendVault("POSITION_MANUAL_CLOSE_BY_USER", "WARN", id,
      { tradeId: row.tradeId, reason: body.reason ?? null });

    const after = await db.select().from(livePositionsTable).where(ownedRow(id, userId)).limit(1);
    res.json({ ...serializeLivePosition(after[0]!), tradeRecordUpdated });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Confirmation required", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /positions/:id/close failed");
    res.status(500).json({ error: "Failed to close position" });
  }
});

// GET /positions/:id/events — append-only timeline
router.get("/positions/:id/events", requireUser, async (req, res): Promise<void> => {
  try {
    // The timeline is read through the position, so ownership is proven on the
    // position row first — position_events.user_id is nullable and cannot be
    // relied on as the predicate.
    const owned = await resolveOwned(req, res);
    if (!owned) return;
    const { id } = owned;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await db.select().from(positionEventsTable)
      .where(eq(positionEventsTable.livePositionId, id))
      .orderBy(desc(positionEventsTable.createdAt))
      .limit(limit);
    res.json({
      events: rows.map((r) => ({
        id: r.id,
        livePositionId: r.livePositionId,
        eventType: r.eventType,
        severity: r.severity,
        message: r.message,
        oldValue: r.oldValue,
        newValue: r.newValue,
        createdAtIso: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /positions/:id/events failed");
    res.status(500).json({ error: "Failed to load events" });
  }
});

export default router;
// Suppress unused-import warnings.
void inArray; void sql;
