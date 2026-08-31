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
import { isSnapshotReliable } from "../lib/live/positionFreshness.js";
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

async function loadMt5Feed(): Promise<{
  positions: Array<Record<string, unknown>>;
  /** When the EA last pushed this feed (mt5_state.last_sync_at), ms epoch. */
  lastSyncAtMs: number | null;
}> {
  const rows = await db.select().from(mt5StateTable).orderBy(asc(mt5StateTable.id)).limit(1);
  const positions = rows[0]?.positions;
  const lastSyncAt = rows[0]?.lastSyncAt ?? null;
  return {
    positions: Array.isArray(positions) ? (positions as Array<Record<string, unknown>>) : [],
    lastSyncAtMs: lastSyncAt ? new Date(lastSyncAt).getTime() : null,
  };
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
 * - Marks rows MANUALLY_CLOSED when they vanish from a RELIABLE (fresh) feed;
 *   on a stale/missing feed vanished rows become SYNC_PENDING instead — a
 *   single lagging or incomplete EA push must never close rows still open at
 *   the broker (canonical positionFreshness rule).
 * Returns the post-sync rows + accumulated warnings for the caller.
 */
async function syncFromBroker() {
  const [{ positions: feed, lastSyncAtMs }, equity] = await Promise.all([loadMt5Feed(), loadAccountEquity()]);
  // Canonical positionFreshness rule (see lib/live/positionFreshness.ts, and
  // meLive/meLiveAccount which enforce it on the newer surfaces): a row missing
  // from ONE feed read is broker-confirmed-absent ONLY when the feed itself is
  // a reliable recent snapshot. mt5_state.last_sync_at is this legacy feed's
  // "sweep landed" marker (stamped by /mt5/sync-positions on every push). When
  // it is stale/missing — EA offline, bridge lagging, or no state row at all —
  // a vanished row proves nothing, and confidently stamping it
  // MANUALLY_CLOSED + closedAt would close positions still open at the broker.
  const FEED_FRESH_MS = 90_000;
  const snapshotReliable = isSnapshotReliable(lastSyncAtMs, FEED_FRESH_MS, Date.now());
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

  // Anything OPEN-ish that vanished from the feed:
  //   • feed snapshot RELIABLE  → broker-confirmed absent → MANUALLY_CLOSED.
  //   • feed snapshot UNRELIABLE → absence proves nothing → SYNC_PENDING
  //     (non-terminal, NO closedAt). The row stays visible awaiting broker
  //     confirmation instead of displaying a fabricated "Closed" with a
  //     timestamp the broker never produced.
  const openish = existing.filter((r) =>
    r.brokerPositionId &&
    !seenBrokerIds.has(r.brokerPositionId) &&
    !POSITION_STATUS_TERMINAL[r.status as LivePositionStatus],
  );
  for (const row of openish) {
    if (!snapshotReliable) {
      if (row.status !== "SYNC_PENDING") {
        await db.update(livePositionsTable).set({
          status: "SYNC_PENDING",
          updatedAt: new Date(),
        }).where(eq(livePositionsTable.id, row.id));
        await appendEvent({ livePositionId: row.id, eventType: "SYNC_PENDING",
          severity: "WARN",
          message: "Position missing from a stale broker feed — NOT treated as closed (no reliable recent snapshot); awaiting broker confirmation",
          oldValue: { status: row.status }, newValue: { status: "SYNC_PENDING" } });
      }
      continue;
    }
    await db.update(livePositionsTable).set({
      status: "MANUALLY_CLOSED",
      closedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(livePositionsTable.id, row.id));
    await appendEvent({ livePositionId: row.id, eventType: "MANUAL_CLOSE",
      severity: "WARN", message: "Position vanished from a fresh broker feed — treated as manual close",
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
      // Broker-mirrored position: the stop that protects the account lives AT
      // THE VENUE. The gate stores every command as BLOCKED (paper-only by
      // construction — routes/mt5.ts queueCommand), so this MODIFY can never
      // reach the broker; updating the local row anyway would display a stop
      // the venue does not have. Refuse with the gate's own verdict instead.
      const gated = await queueMt5CommandWithGate("MODIFY", {
        ticket: Number(row.brokerPositionId) || null,
        sl: body.stopLoss ?? null,
        tp: row.takeProfit ?? null,
      });
      if (gated.command.status !== "PENDING") {
        res.status(409).json({
          error: "Stop-loss change could not be delivered to the broker — the stop at the venue is unchanged, so nothing was updated here either.",
          commandStatus: gated.command.status,
          blockedReason: gated.blockedReason ?? gated.command.detail ?? null,
          mode: gated.mode,
        });
        return;
      }
      // Deliverable (not producible today — the gate hardcodes BLOCKED):
      // queued is still not confirmed. The stored stop updates when the EA's
      // MODIFY result lands (lib/mt5/executionReconciler.ts).
      res.status(202).json({
        accepted: true,
        message: "Stop-loss change queued for the broker. The stored stop updates when the broker confirms the modify.",
        commandStatus: gated.command.status,
      });
      return;
    }
    // Local-only row (no broker linkage) — the stored stop is the record.
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
      // Same honesty rule as /stop-loss: the take-profit lives at the venue,
      // and the gate stores every command BLOCKED, so a local update would
      // display a TP the broker does not have. Refuse with the gate's verdict.
      const gated = await queueMt5CommandWithGate("MODIFY", {
        ticket: Number(row.brokerPositionId) || null,
        sl: row.stopLoss ?? null,
        tp: body.takeProfit ?? null,
      });
      if (gated.command.status !== "PENDING") {
        res.status(409).json({
          error: "Take-profit change could not be delivered to the broker — the take-profit at the venue is unchanged, so nothing was updated here either.",
          commandStatus: gated.command.status,
          blockedReason: gated.blockedReason ?? gated.command.detail ?? null,
          mode: gated.mode,
        });
        return;
      }
      res.status(202).json({
        accepted: true,
        message: "Take-profit change queued for the broker. The stored take-profit updates when the broker confirms the modify.",
        commandStatus: gated.command.status,
      });
      return;
    }
    // Local-only row (no broker linkage) — the stored take-profit is the record.
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
    // The price the operator confirms against must say WHICH price it is. When
    // the sync has never reported a current price, falling back to the entry
    // silently would read as "the market is here now" — it is not.
    const priceLabel = row.currentPrice != null
      ? `${row.currentPrice}`
      : `${row.entryPrice} (entry price — no current price synced)`;
    res.json({
      requiresConfirmation: true,
      // uPnL degrades to a labeled unknown when the sync never reported one —
      // "0" would be a confident claim of break-even we cannot make.
      summary: `Close ${row.direction} ${row.symbol} @ ${priceLabel} (uPnL ${row.unrealizedProfitLoss ?? "unknown — not yet synced"})`,
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
      // Broker-mirrored position: the only honest close is one the broker
      // confirms. The gate stores every command as BLOCKED (paper-only by
      // construction — routes/mt5.ts queueCommand hardcodes status="BLOCKED",
      // and the EA poll delivers only PENDING), so this CLOSE can never reach
      // the venue. Stamping MANUALLY_CLOSED + a realized P/L here displayed a
      // close the broker never performed — the old "Live-Trades Close is a
      // mock" defect surviving on this legacy route. Refuse instead, surfacing
      // the gate's own verdict; the row stays exactly as the broker last
      // reported it. Real wiring that would replace this refusal: a
      // fill-confirmed close (the meTrades LIVE path dispatches through the
      // Phase-B pipeline, and lib/mt5/executionReconciler.ts already stamps
      // this row's status/closedAt/realizedProfitLoss when a real CLOSE
      // result arrives).
      const gated = await queueMt5CommandWithGate("CLOSE", {
        ticket: Number(row.brokerPositionId) || null,
      });
      if (gated.command.status !== "PENDING") {
        await appendEvent({ livePositionId: id, eventType: "MANUAL_CLOSE_REFUSED", severity: "WARN",
          message: `Close refused: broker command not deliverable (${gated.command.status}). ${gated.blockedReason ?? gated.command.detail ?? ""}`.trim(),
          oldValue: { status: row.status }, newValue: { commandStatus: gated.command.status } });
        res.status(409).json({
          error: "Close command could not be delivered to the broker — the position was NOT closed and no P/L was recorded.",
          commandStatus: gated.command.status,
          blockedReason: gated.blockedReason ?? gated.command.detail ?? null,
          mode: gated.mode,
          aiExplanation: "Marking a broker-mirrored position closed while the close command cannot reach the broker would fabricate a close and a realized P/L. The position remains open at the venue and unchanged here.",
        });
        return;
      }
      // Deliverable (not producible today — the gate hardcodes BLOCKED; kept
      // honest in case delivery is ever re-enabled): queued is still not
      // filled. The row is stamped closed with a real P/L only when the EA's
      // CLOSE result lands (lib/mt5/executionReconciler.ts).
      res.status(202).json({
        accepted: true,
        message: "Close command queued for the broker. The position remains OPEN here until the broker confirms the close — no P/L is recorded until then.",
        commandStatus: gated.command.status,
      });
      return;
    }
    // Local-only row (no broker linkage) — the mirror itself is the record, so
    // a manual close of it is real.
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
      // Only a REALIZED figure may close the trade as pnlStatus="COMPUTED":
      // row.realizedProfitLoss is written exclusively from real broker CLOSE
      // fills (lib/mt5/executionReconciler.ts computes it from the fill price
      // with established contract size + FX). The old fallback to
      // row.unrealizedProfitLoss stamped a last-synced FLOATING mark of
      // unbounded age as a trusted realized P/L — fabrication. Without a
      // realized figure we refuse to invent one: pnl=null, pnlStatus="UNKNOWN"
      // + a data-quality flag, so Trade Logs renders "P/L unavailable" and
      // analytics aggregates exclude the row.
      const rawPnl = row.realizedProfitLoss;
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
