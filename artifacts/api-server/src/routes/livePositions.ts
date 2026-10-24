// Build H — Live Position Management routes.
//
// COMPOSES:
//   - mt5_state.positions JSONB (broker truth feed, synced via /mt5/sync-positions)
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
//   - Stop / target edits and closes go to the broker through the venue's
//     governed queue (lib/positions/governedOps.ts); these routes never edit
//     the ledger to pretend the broker already did it.

import { demoPositionWriter, demoPositionLedger, demoPositionColumns, type DemoPositionRow } from "../lib/positions/ledger.js";
import { Router } from "express";
import { db, positionEventsTable, vaultEventsTable } from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  evaluateLivePosition,
  POSITION_STATUS_TERMINAL,
  type LivePositionStatus,
} from "@workspace/domain/live-position";
import { requireUser } from "../lib/auth/middleware.js";
import {
  findGovernedPosition,
  submitGovernedClose,
  submitGovernedModify,
  type GovernedOpResult,
  type GovernedPosition,
} from "../lib/positions/governedOps.js";
import { canSeeLegacyRows, ownerScope } from "../lib/auth/ownerScope.js";
import { readPlatformMt5State } from "../lib/brokerHub/mt5StateReader.js";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

async function loadMt5Positions(): Promise<Array<Record<string, unknown>>> {
  const positions = (await readPlatformMt5State())?.positions;
  return Array.isArray(positions) ? (positions as Array<Record<string, unknown>>) : [];
}
async function loadAccountEquity(): Promise<number | null> {
  return (await readPlatformMt5State())?.equity ?? null;
}

// Ownership: a trader sees and acts on their own rows only. The central
// /positions/sync feed writes user_id=NULL rows for the server-wide MT5
// connection; those are operator rows (ADMIN/OWNER only). Anything else is 404.
async function ownPosition(id: number, authUser: Parameters<typeof ownerScope>[1]) {
  if (!Number.isFinite(id)) return null;
  const rows = await demoPositionLedger.read({
    where: and(eq(demoPositionColumns.id, id), ownerScope(demoPositionColumns.userId, authUser)),
    limit: 1,
  });
  return rows[0] ?? null;
}

// Stop edits, target edits and closes go through the one governed path
// (lib/positions/governedOps.ts). Only the trader's own ARX-governed positions
// can be changed from here; the server-wide feed rows (user_id NULL) and
// positions opened outside ARX are changed in the trading terminal.
const POSITIONS_PAGE_SOURCE = "POSITIONS_PAGE";

async function governedPositionFor(row: DemoPositionRow, userId: number): Promise<GovernedPosition | null> {
  if (row.userId !== userId || !row.brokerPositionId) return null;
  return findGovernedPosition(userId, row.brokerPositionId, row.lotSize);
}

function notGoverned(res: import("express").Response, row: DemoPositionRow): void {
  res.status(409).json({
    error: "NOT_AN_ARX_GOVERNED_POSITION",
    message: row.userId == null
      ? "This row mirrors the shared broker feed; change it in the trading terminal."
      : "ARX did not open this position, so it cannot change it; use your trading terminal.",
  });
}

function refused(res: import("express").Response, op: GovernedOpResult): void {
  res.status(422).json({ error: op.reason ?? "Refused", code: "GOVERNED_QUEUE_REFUSED", commandId: op.commandId });
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

function serializeLivePosition(row: DemoPositionRow) {
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
async function syncFromBroker(visible: ReturnType<typeof ownerScope>) {
  const [feed, equity] = await Promise.all([loadMt5Positions(), loadAccountEquity()]);
  // UX9 hardening — this central /positions/sync feed currently inserts rows
  // with user_id=NULL (the single legacy MT5 connection on the server). With
  // the new composite uniqueness on (user_id, broker_position_id), real
  // per-user rows can legitimately share a broker_position_id with these
  // NULL-user rows. Scope the existing-row read to user_id IS NULL so we
  // never read or update a tenant's row by ticket alone.
  const existing = await demoPositionLedger.read({ where: isNull(demoPositionColumns.userId) });
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
      const inserted = await demoPositionWriter.insertReturning(
        {
          brokerPositionId: ticket,
          symbol,
          direction,
          lotSize,
          entryPrice,
          currentPrice,
          stopLoss,
          takeProfit,
          unrealizedProfitLoss: verdict.unrealizedPnL,
          rewardToRisk: verdict.rewardToRisk,
          status: verdict.status,
          openedAt: new Date(),
          lastSyncedAt: new Date(),
        },
        demoPositionColumns,
        true,
      );
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

    await demoPositionWriter.update(
      {
        currentPrice,
        stopLoss,
        takeProfit,
        unrealizedProfitLoss: verdict.unrealizedPnL,
        rewardToRisk: verdict.rewardToRisk,
        status: verdict.status,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
        ...(POSITION_STATUS_TERMINAL[verdict.status] && !prev.closedAt ? { closedAt: new Date() } : {}),
      },
      eq(demoPositionColumns.id, prev.id),
    );
  }

  // Anything OPEN-ish that vanished from the feed → MANUALLY_CLOSED.
  const openish = existing.filter((r) =>
    r.brokerPositionId &&
    !seenBrokerIds.has(r.brokerPositionId) &&
    !POSITION_STATUS_TERMINAL[r.status as LivePositionStatus],
  );
  for (const row of openish) {
    await demoPositionWriter.update(
      {
        status: "MANUALLY_CLOSED",
        closedAt: new Date(),
        updatedAt: new Date(),
      },
      eq(demoPositionColumns.id, row.id),
    );
    await appendEvent({ livePositionId: row.id, eventType: "MANUAL_CLOSE",
      severity: "WARN", message: "Position vanished from broker feed — treated as manual close",
      oldValue: { status: row.status }, newValue: { status: "MANUALLY_CLOSED" } });
    await appendVault("POSITION_MANUAL_CLOSE", "WARN", row.id, { tradeId: row.tradeId });
  }

  const after = await demoPositionLedger.read({ where: visible, orderBy: [desc(demoPositionColumns.updatedAt)] });
  return after;
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /positions — current open positions (non-terminal statuses)
router.get("/positions", requireUser, async (req, res) => {
  try {
    const all = await demoPositionLedger.read({
      where: ownerScope(demoPositionColumns.userId, req.authUser),
      orderBy: [desc(demoPositionColumns.updatedAt)],
    });
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
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const row = await ownPosition(id, req.authUser);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serializeLivePosition(row));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /positions/:id failed");
    res.status(500).json({ error: "Failed to load position" });
  }
});

// POST /positions/sync — pull from mt5_state, update live_positions
// The feed is the single server-wide MT5 connection, so only an operator may
// reconcile it; per-user positions arrive through the per-user bridge.
router.post("/positions/sync", requireUser, async (req, res): Promise<void> => {
  try {
    if (!canSeeLegacyRows(req.authUser)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Only an operator can sync the shared broker feed." });
      return;
    }
    const after = await syncFromBroker(ownerScope(demoPositionColumns.userId, req.authUser));
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
    const id = Number(req.params.id);
    const body = SLBody.parse(req.body ?? {});
    const row = await ownPosition(id, req.authUser);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    // Inviolable rule: removing SL requires explicit confirmation.
    if (body.stopLoss == null && !body.removeConfirmed) {
      res.status(409).json({
        error: "Removing the stop loss requires explicit confirmation.",
        blockers: ["pass removeConfirmed:true to remove the stop loss"],
        aiExplanation: "Removing your stop loss is one of the most account-damaging actions you can take. Confirm explicitly if this is truly intentional.",
      });
      return;
    }

    // One governed path: the venue's own queue (arming, kill switch, Risk
    // Governor — removing or widening is checked against the trader's
    // stop-loss requirement and per-trade loss limit). The ledger row is NOT
    // edited here; the broker result and the next snapshot move it.
    const pos = await governedPositionFor(row, req.authUser!.id);
    if (!pos) { notGoverned(res, row); return; }
    const op = await submitGovernedModify(req.authUser!.id, pos, body.stopLoss ?? null, row.takeProfit ?? null, POSITIONS_PAGE_SOURCE);
    if (!op.ok) { refused(res, op); return; }
    await appendEvent({ livePositionId: id,
      eventType: body.stopLoss == null ? "SL_REMOVE_REQUESTED" : "SL_MOVE_REQUESTED",
      severity: body.stopLoss == null ? "DANGER" : "INFO",
      message: body.stopLoss == null ? "Trader asked the broker to remove the stop loss" : `Trader asked the broker to move SL ${row.stopLoss} → ${body.stopLoss}`,
      oldValue: { stopLoss: row.stopLoss }, newValue: { stopLoss: body.stopLoss, commandId: op.commandId } });
    await appendVault(body.stopLoss == null ? "POSITION_SL_REMOVE_REQUESTED_BY_USER" : "POSITION_SL_MOVE_REQUESTED_BY_USER",
      body.stopLoss == null ? "DANGER" : "INFO", id,
      { tradeId: row.tradeId, oldStopLoss: row.stopLoss, newStopLoss: body.stopLoss, reason: body.reason ?? null, commandId: op.commandId, venue: pos.venue });
    res.json({ ...serializeLivePosition(row), pending: { commandId: op.commandId, venue: pos.venue, stopLoss: body.stopLoss } });
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
    const id = Number(req.params.id);
    const body = TPBody.parse(req.body ?? {});
    const row = await ownPosition(id, req.authUser);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    const pos = await governedPositionFor(row, req.authUser!.id);
    if (!pos) { notGoverned(res, row); return; }
    const op = await submitGovernedModify(req.authUser!.id, pos, row.stopLoss ?? null, body.takeProfit ?? null, POSITIONS_PAGE_SOURCE);
    if (!op.ok) { refused(res, op); return; }
    await appendEvent({ livePositionId: id, eventType: "TP_MOVE_REQUESTED", severity: "INFO",
      message: `Trader asked the broker to move TP ${row.takeProfit} → ${body.takeProfit}`,
      oldValue: { takeProfit: row.takeProfit }, newValue: { takeProfit: body.takeProfit, commandId: op.commandId } });
    res.json({ ...serializeLivePosition(row), pending: { commandId: op.commandId, venue: pos.venue, takeProfit: body.takeProfit } });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /positions/:id/take-profit failed");
    res.status(500).json({ error: "Failed to update take profit" });
  }
});

// POST /positions/:id/close-confirmation — returns a verdict the UI must echo back to /close
router.post("/positions/:id/close-confirmation", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const row = await ownPosition(id, req.authUser);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
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
    const id = Number(req.params.id);
    const body = CloseBody.parse(req.body ?? {});
    const row = await ownPosition(id, req.authUser);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (POSITION_STATUS_TERMINAL[row.status as LivePositionStatus]) {
      res.status(409).json({ error: "Position already terminal", status: row.status });
      return;
    }

    // The close goes to the broker through the venue's governed queue. The
    // position stays open in the ledger (and protected by the Position
    // Guardian) until the broker confirms the close; P/L comes from the fill.
    const pos = await governedPositionFor(row, req.authUser!.id);
    if (!pos) { notGoverned(res, row); return; }
    const op = await submitGovernedClose(req.authUser!.id, pos, POSITIONS_PAGE_SOURCE);
    if (!op.ok) { refused(res, op); return; }
    await appendEvent({ livePositionId: id, eventType: "CLOSE_REQUESTED", severity: "WARN",
      message: `Trader asked the broker to close the position: ${body.reason ?? "no reason given"}`,
      oldValue: { status: row.status }, newValue: { commandId: op.commandId } });
    await appendVault("POSITION_CLOSE_REQUESTED_BY_USER", "WARN", id,
      { tradeId: row.tradeId, reason: body.reason ?? null, commandId: op.commandId, venue: pos.venue });
    res.json({ ...serializeLivePosition(row), pending: { commandId: op.commandId, venue: pos.venue, close: true } });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Confirmation required", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /positions/:id/close failed");
    res.status(500).json({ error: "Failed to close position" });
  }
});

// GET /positions/:id/events — append-only timeline
router.get("/positions/:id/events", requireUser, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    if (!(await ownPosition(id, req.authUser))) { res.status(404).json({ error: "Not found" }); return; }
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
