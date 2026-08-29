// Phase B — EA-facing LIVE execution endpoints.
//
// SAFETY (inviolable):
// - All routes are guarded by `bridgeAuthPerUserOnly`. Server-wide
//   server-wide bridge token env value is REJECTED.
// - Every route asserts `mt5Connection.accountType` is "live" or "real".
//   Demo bridges hitting these endpoints are refused with 403
//   BRIDGE_NOT_LIVE_ACCOUNT.
// - Live commands are NEVER read or written by the demo poll endpoints, and
//   vice versa — the demo path (`/api/mt5/demo-commands-poll`) reads only
//   from `mt5_demo_commands`; this file reads only from `arx_live_commands`.
// - Per-user isolation: every query is scoped by `req.mt5Connection.userId`.

import { Router, type Request, type Response } from "express";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db, arxLiveCommandsTable, arxLivePositionsTable, mt5ConnectionTable } from "@workspace/db";
import { bridgeAuthPerUserOnly } from "./mt5.js";
import { brokerAbsenceAutoReconcilePolicy } from "../lib/live/brokerAbsencePolicy.js";
import { runBrokerAbsenceReconcile } from "../lib/live/brokerAbsenceReconcileRunner.js";
import { observeBrokerSideCloses } from "../lib/live/brokerCloseObserver.js";
import type { BrokerCloseReport } from "../lib/live/brokerCloseOutcome.js";
import {
  pickupNextLiveCommand,
  recordLiveCommandResult,
  findGhostClosedPositionIds,
} from "../lib/live/liveCommandPipeline.js";
import { resolveBrokerSymbolName } from "../lib/mt5/brokerSymbolName.js";
import { emitLiveAccountChanged } from "../lib/live/liveAccountEventBus.js";

const router = Router();

interface AugReq extends Request {
  mt5Connection?: typeof mt5ConnectionTable.$inferSelect;
}

function requireLiveBridge(req: AugReq, res: Response): typeof mt5ConnectionTable.$inferSelect | null {
  const conn = req.mt5Connection;
  if (!conn) {
    res.status(401).json({ error: "BRIDGE_AUTH_REQUIRED" });
    return null;
  }
  const acct = (conn.accountType ?? "").toLowerCase();
  if (acct !== "live" && acct !== "real") {
    res.status(403).json({
      error: "BRIDGE_NOT_LIVE_ACCOUNT",
      detail: `Live endpoints require accountType=live/real. Bridge reports "${conn.accountType ?? "?"}".`,
    });
    return null;
  }
  // Phase B MOCK refusal at the EA-facing edge. A MOCK placeholder cannot
  // poll live commands or write live results even if its accountType
  // column reads 'live'. The heartbeat ingest path is what lifts a real
  // EA out of MOCK (mode -> LIVE on first heartbeat with accountType).
  if (conn.mode === "MOCK") {
    res.status(403).json({
      error: "BRIDGE_IS_MOCK_NOT_LIVE_CAPABLE",
      detail: `Bridge ${conn.id} is a MOCK placeholder. A real MT5 EA must POST /api/mt5/heartbeat with accountType=live/real before live endpoints accept it.`,
    });
    return null;
  }
  if (conn.userId == null) {
    res.status(401).json({ error: "BRIDGE_NO_USER_ATTRIBUTION" });
    return null;
  }
  return conn;
}

const LIVE_SAFETY_ENVELOPE = {
  safetyMode: "phase_b_live" as const,
  liveDispatchPath: "phase_b" as const,
  perUserIsolation: true as const,
};

// ── POST /api/mt5/live-commands-poll ───────────────────────────────────────
// EA pulls the next SENT_TO_MT5_LIVE command for its bridge.
router.post("/mt5/live-commands-poll", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireLiveBridge(req, res);
  if (!conn) return;
  const result = await pickupNextLiveCommand({
    userId: conn.userId!,
    bridgeConnectionId: conn.id,
    bridgeAccountType: conn.accountType,
  });
  if (result.refusalReason) {
    res.status(403).json({ error: result.refusalReason, ...LIVE_SAFETY_ENVELOPE });
    return;
  }
  if (!result.command) {
    res.json({ command: null, ...LIVE_SAFETY_ENVELOPE });
    return;
  }
  const c = result.command;
  // Task #28 — expose TTL freshness to the EA. `secondsUntilExpiry` is
  // computed server-side so the EA never has to parse ISO timestamps or
  // trust its own wall-clock: if it is <= 0 the EA refuses the command with
  // STALE_COMMAND_REJECTED. `expiresAt`/`serverTimestamp`/`ttlSeconds` are
  // included for audit + forward-compat.
  const nowMs = Date.now();
  const expiresAtMs = c.expiresAt ? new Date(c.expiresAt).getTime() : null;
  const secondsUntilExpiry = expiresAtMs != null
    ? Math.floor((expiresAtMs - nowMs) / 1000)
    : null;
  // Transport-layer name translation: hand the EA the broker's EXACT,
  // case-sensitive Market Watch symbol (e.g. "Volatility 75 Index") rather
  // than ARX's internal uppercased/alias form. No-op for forex; verbatim
  // fallback for anything not in the registry. Does NOT alter the stored
  // command or any safety gate.
  const brokerSymbol = await resolveBrokerSymbolName(c.symbol);
  res.json({
    command: {
      commandId: c.commandId,
      commandType: c.commandType,
      symbol: brokerSymbol,
      side: c.side,
      orderType: c.orderType,
      requestedVolume: c.requestedVolume,
      stopLoss: c.stopLoss,
      takeProfit: c.takeProfit,
      // Task #30 — drafted reference price for the EA's slippage/deviation
      // guard. Stored on payload at draft; null when the caller drafted no
      // reference price (EA then skips the deviation leg, fail-open).
      referencePrice: ((): number | null => {
        const p = c.payload as Record<string, unknown> | null | undefined;
        const v = p?.["referencePrice"];
        return typeof v === "number" && v > 0 ? v : null;
      })(),
      payload: c.payload,
      accountLogin: c.accountLogin,
      brokerServer: c.brokerServer,
      ttlSeconds: c.ttlSeconds,
      expiresAt: c.expiresAt,
      serverTimestamp: c.serverTimestamp,
      secondsUntilExpiry,
    },
    ...LIVE_SAFETY_ENVELOPE,
  });
});

// ── POST /api/mt5/live-command-result ──────────────────────────────────────
// EA reports a LIVE_FILLED / LIVE_REJECTED / LIVE_FAILED / STALE_COMMAND_REJECTED
// outcome. STALE_COMMAND_REJECTED (Task #28) is the EA refusing a command whose
// TTL had already elapsed when it polled it; the server maps it to LIVE_EXPIRED.
router.post("/mt5/live-command-result", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireLiveBridge(req, res);
  if (!conn) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const commandId = typeof b["commandId"] === "string" ? b["commandId"] : null;
  // EA v1.27 posts the result under the field name `status`. Earlier
  // server drafts used `outcome`. Accept BOTH for forward/backward
  // compatibility — otherwise live commands would be trapped in
  // SENT_TO_MT5_LIVE and the EA loop could re-execute them.
  const outcomeRaw =
    typeof b["status"] === "string" ? b["status"]
    : typeof b["outcome"] === "string" ? b["outcome"]
    : null;
  const allowedOutcomes = ["LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "STALE_COMMAND_REJECTED"] as const;
  if (!commandId || !outcomeRaw || !(allowedOutcomes as readonly string[]).includes(outcomeRaw)) {
    res.status(400).json({ error: "INVALID_BODY", detail: "commandId and status required" });
    return;
  }
  const outcome = outcomeRaw as (typeof allowedOutcomes)[number];

  // Ownership re-check: the command must belong to this bridge's user.
  const owned = await db.select().from(arxLiveCommandsTable)
    .where(and(eq(arxLiveCommandsTable.commandId, commandId), eq(arxLiveCommandsTable.userId, conn.userId!)))
    .limit(1);
  if (!owned[0]) {
    res.status(404).json({ error: "COMMAND_NOT_FOUND_FOR_USER" });
    return;
  }

  const result = await recordLiveCommandResult({
    userId: conn.userId!,
    commandId,
    outcome,
    reportingBridgeConnectionId: conn.id,
    brokerTicket: typeof b["brokerTicket"] === "string" || typeof b["brokerTicket"] === "number" ? String(b["brokerTicket"]) : null,
    fillPrice: typeof b["fillPrice"] === "number" ? Number(b["fillPrice"]) : null,
    executedVolume: typeof b["executedVolume"] === "number" ? Number(b["executedVolume"]) : null,
    mt5Retcode: typeof b["mt5Retcode"] === "number" ? Number(b["mt5Retcode"]) : null,
    brokerMessage: typeof b["brokerMessage"] === "string" ? String(b["brokerMessage"]) : null,
    // EA-side preflight refusals (PreTradeBrokerGuard, lot ceiling, maintenance,
    // command-type, etc.) carry their precise cause ONLY in the `reason` field —
    // there is no mt5Retcode/brokerMessage because the broker was never called.
    // Capture it so the row surfaces the real cause instead of EA_REJECTED_NO_DETAIL.
    eaReason: typeof b["reason"] === "string" ? String(b["reason"]) : null,
  });
  // Task #1 — fill/reject changes user reservedRisk + positions; refresh pool.
  void (async () => {
    try {
      const { recomputeMasterPool } = await import("../lib/live/masterBridgePool.js");
      await recomputeMasterPool();
    } catch (err) {
      req.log.warn({ err }, "Master pool recompute after live-command-result failed");
    }
  })();
  res.status(result.ok ? 200 : 409).json({ ...result, ...LIVE_SAFETY_ENVELOPE });
});

// Coerce helpers for EA open-position snapshot fields. Two EA generations use
// different field names for the same broker truth, so ingest tolerates both.
function snapNumOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
// MT5 reports 0.0 for "no stop/target". Treat 0 as absent so the UI never
// renders a phantom SL/TP of 0.00000.
function snapNonZeroOrNull(v: unknown): number | null {
  const n = snapNumOrNull(v);
  return n != null && n !== 0 ? n : null;
}
// Parse MT5 TimeToString "YYYY.MM.DD HH:MM:SS" (v1.50 `openTime`) or an ISO
// string (older `openedAt`). MT5 emits broker-server time without a zone; we
// record it as UTC — best-effort for the openedAt display stamp only, never
// fabricated. Returns null when unparseable.
function parseMt5Time(v: unknown): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim();
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// ── Broker-REPORTED closes (outcome truth) ─────────────────────────────────
//
// A position closed by its own STOP-LOSS at the broker never produces an ARX
// close command, so it used to leave no trace in the mission record at all —
// only ARX-issued closes (take-profit, trailing, protective) were recorded, and
// the realised figure drifted upward. An EA that can report its closed deals
// sends them alongside the open-position sweep as `closed: [...]`; every field
// except the ticket is optional, because a broker may report a close without
// giving us numbers.
//
// HONESTY: whatever arrives is stored VERBATIM. A missing profit is stored as
// NULL and the mission outcome is recorded UNRECONCILED — never inferred from
// the stop-loss level, the take-profit level, or the last floating P/L.
interface ParsedBrokerCloseReport extends BrokerCloseReport {
  closedAt: Date | null;
}

function parseBrokerCloseReports(body: Record<string, unknown>): ParsedBrokerCloseReport[] {
  const raw = body["closed"] ?? body["closedPositions"];
  if (!Array.isArray(raw)) return [];
  const out: ParsedBrokerCloseReport[] = [];
  const seen = new Set<string>();
  for (const item of raw as Array<Record<string, unknown>>) {
    if (item == null || typeof item !== "object") continue;
    const ticketRaw = item["brokerTicket"] ?? item["ticket"];
    const ticket =
      typeof ticketRaw === "string" || typeof ticketRaw === "number" ? String(ticketRaw).trim() : "";
    if (ticket.length === 0 || seen.has(ticket)) continue;
    seen.add(ticket);
    out.push({
      brokerTicket: ticket,
      // A realised P/L may legitimately be negative or zero — only a non-number
      // is refused. A close FILL price of 0 is MT5's "no value", so it is
      // rejected by snapNonZeroOrNull rather than stored as a real price.
      brokerRealisedPnl: snapNumOrNull(item["profit"] ?? item["realisedPnl"] ?? item["realizedPnl"]),
      brokerClosePrice: snapNonZeroOrNull(item["closePrice"] ?? item["price"]),
      closedAt: parseMt5Time(item["closedAt"] ?? item["closeTime"]),
    });
  }
  return out;
}

// ── Live open-positions snapshot ingest (shared) ───────────────────────────
// Both EA generations POST the broker's COMPLETE list of currently-open live
// positions for this bridge:
//   • v1.27–1.29 → /api/mt5/sync-live-positions (brokerTicket/stopLoss/
//     takeProfit/openedAt)
//   • v1.50+     → /api/mt5/positions-snapshot   (ticket/sl/tp/openTime)
// Same meaning → one shared ingest. Upserts on (userId, brokerTicket).
// Positions absent from the snapshot are NOT auto-closed here — auto-close is
// ALERT_ONLY; only ARX-initiated LIVE_FILLED closes are reconciled below
// (recording a close the broker already executed, never initiating one).
async function handleLivePositionsSnapshot(req: AugReq, res: Response): Promise<void> {
  const conn = requireLiveBridge(req, res);
  if (!conn) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const positions = Array.isArray(b["positions"]) ? (b["positions"] as Array<Record<string, unknown>>) : [];

  // Resolve the ARX live command that opened a given broker ticket, if any.
  // Only an exact (userId, brokerTicket, LIVE_FILLED) match counts — we never
  // fabricate a link. Used for both first-insert linkage and later backfill.
  const findFillCommandId = async (ownerId: number, tkt: string): Promise<string | null> => {
    const fill = await db.select({ commandId: arxLiveCommandsTable.commandId })
      .from(arxLiveCommandsTable)
      .where(and(
        eq(arxLiveCommandsTable.userId, ownerId),
        eq(arxLiveCommandsTable.brokerTicket, tkt),
        eq(arxLiveCommandsTable.status, "LIVE_FILLED"),
      )).limit(1);
    return fill[0]?.commandId ?? null;
  };

  // Single clock for this sweep so all absence-evidence timestamps agree.
  const snapshotNow = new Date();
  // Broker tickets present in THIS reliable complete sweep — used to reset the
  // absence counter for re-confirmed positions and to detect absent ones.
  const presentTickets = new Set<string>();

  let upserts = 0;
  for (const p of positions) {
    // v1.50 sends `ticket`; v1.27 sent `brokerTicket`.
    const ticketRaw = p["brokerTicket"] ?? p["ticket"];
    const ticket = typeof ticketRaw === "string" || typeof ticketRaw === "number" ? String(ticketRaw) : null;
    const symbol = typeof p["symbol"] === "string" ? p["symbol"] : null;
    const side = typeof p["side"] === "string" ? p["side"] : null;
    const volume = snapNumOrNull(p["volume"]);
    const entryPrice = snapNumOrNull(p["entryPrice"]);
    if (!ticket || !symbol || !side || volume == null || entryPrice == null) continue;
    // openedAt is display-only; a bad/missing time must not drop a real
    // position, so fall back to now() on first insert.
    const openedAt = parseMt5Time(p["openedAt"] ?? p["openTime"]) ?? new Date();
    presentTickets.add(ticket);

    const existing = await db.select().from(arxLivePositionsTable)
      .where(and(
        eq(arxLivePositionsTable.userId, conn.userId!),
        eq(arxLivePositionsTable.brokerTicket, ticket),
      )).limit(1);

    const common = {
      symbol,
      side,
      volume,
      entryPrice,
      currentPrice: snapNumOrNull(p["currentPrice"]),
      floatingPl: snapNumOrNull(p["floatingPl"]),
      stopLoss: snapNonZeroOrNull(p["stopLoss"] ?? p["sl"]),
      takeProfit: snapNonZeroOrNull(p["takeProfit"] ?? p["tp"]),
      bridgeConnectionId: conn.id,
      accountLogin: conn.accountNumber,
      brokerServer: conn.brokerName,
      lastSyncedAt: snapshotNow,
      // Position re-confirmed open by this reliable complete sweep → reset its
      // broker-absence evidence (matches nextAbsenceEvidence present-branch).
      brokerAbsentSnapshotCount: 0,
      firstBrokerAbsentAt: null,
      lastBrokerAbsentAt: null,
      lastReliableSnapshotAt: snapshotNow,
    };
    if (existing[0]) {
      // Backfill the ARX command link if the snapshot row landed BEFORE the
      // command reached LIVE_FILLED (so it was inserted with no link). Without
      // this, a genuine ARX-placed position stays mislabeled broker_sync forever.
      // Only backfill when currently unlinked; never overwrite an existing link.
      let backfill: { sourceCommandId?: string } = {};
      if (existing[0].sourceCommandId == null) {
        const linkId = await findFillCommandId(conn.userId!, ticket);
        if (linkId) backfill = { sourceCommandId: linkId };
      }
      await db.update(arxLivePositionsTable).set({ ...common, ...backfill })
        .where(eq(arxLivePositionsTable.id, existing[0].id));
    } else {
      // Link this snapshot position back to the ARX live command that opened it
      // (the broker ticket matches a LIVE_FILLED command for this user). When a
      // link exists the UI shows it as an ARX-placed live trade; with no link it
      // is honestly flagged as a broker-detected position opened outside ARX. We
      // NEVER fabricate a link — only an exact broker-ticket match counts.
      const linkId = await findFillCommandId(conn.userId!, ticket);
      await db.insert(arxLivePositionsTable).values({
        userId: conn.userId!,
        brokerTicket: ticket,
        openedAt,
        sourceCommandId: linkId,
        ...common,
      });
    }
    upserts += 1;
  }

  // Task #28 (T003) — forced reconciliation. Any position still marked open
  // (closedAt IS NULL) whose ticket has a LIVE_FILLED CLOSE command is a
  // ghost: the broker confirmed the close but the snapshot never cleared it
  // (e.g. the position dropped out of the EA snapshot before closedAt was
  // stamped). Stamp closedAt from broker truth. Still ALERT_ONLY — we never
  // initiate a close, only record one the broker already executed.
  let reconciledClosed = 0;
  try {
    const openRows = await db.select({
      id: arxLivePositionsTable.id,
      brokerTicket: arxLivePositionsTable.brokerTicket,
    }).from(arxLivePositionsTable).where(and(
      eq(arxLivePositionsTable.userId, conn.userId!),
      isNull(arxLivePositionsTable.closedAt),
    ));
    if (openRows.length > 0) {
      const filledCloses = await db.select({
        payload: arxLiveCommandsTable.payload,
        brokerTicket: arxLiveCommandsTable.brokerTicket,
      }).from(arxLiveCommandsTable).where(and(
        eq(arxLiveCommandsTable.userId, conn.userId!),
        eq(arxLiveCommandsTable.commandType, "CLOSE_LIVE_POSITION"),
        eq(arxLiveCommandsTable.status, "LIVE_FILLED"),
      ));
      const ghostIds = findGhostClosedPositionIds(
        openRows.map((r) => ({ id: r.id, brokerTicket: r.brokerTicket ?? "" })),
        filledCloses.map((c) => ({
          brokerTicket: c.brokerTicket,
          payload: c.payload as Record<string, unknown> | null,
        })),
      );
      if (ghostIds.length > 0) {
        await db.update(arxLivePositionsTable).set({
          closedAt: new Date(),
          lastSyncedAt: new Date(),
        }).where(and(
          eq(arxLivePositionsTable.userId, conn.userId!),
          inArray(arxLivePositionsTable.id, ghostIds),
          isNull(arxLivePositionsTable.closedAt),
        ));
        reconciledClosed = ghostIds.length;
      }
    }
  } catch (err) {
    req.log.warn({ err }, "sync-live-positions ghost-close reconciliation failed");
  }

  // Broker-Side Close Reconciliation Guardrail — consecutive reliable-absence
  // evidence. This sweep is a reliable COMPLETE broker snapshot (the EA pushes
  // the full open-position list), so any still-open, not-yet-reconciled row for
  // THIS user+bridge whose ticket is NOT in the snapshot is absent for this
  // sweep: increment its absence counter and stamp first/last-absent. Present
  // rows were already reset above (common). This only ACCUMULATES evidence —
  // it never stamps closed_at here. Best-effort; a failure must not fail ingest.
  try {
    const absentOpen = await db.select({
      id: arxLivePositionsTable.id,
      brokerTicket: arxLivePositionsTable.brokerTicket,
    }).from(arxLivePositionsTable).where(and(
      eq(arxLivePositionsTable.userId, conn.userId!),
      eq(arxLivePositionsTable.bridgeConnectionId, conn.id),
      isNull(arxLivePositionsTable.closedAt),
      isNull(arxLivePositionsTable.reconcileState),
    ));
    const absentIds = absentOpen
      .filter((r) => typeof r.brokerTicket === "string" && r.brokerTicket.length > 0 && !presentTickets.has(r.brokerTicket))
      .map((r) => r.id);
    if (absentIds.length > 0) {
      await db.update(arxLivePositionsTable).set({
        brokerAbsentSnapshotCount: sql`${arxLivePositionsTable.brokerAbsentSnapshotCount} + 1`,
        lastBrokerAbsentAt: snapshotNow,
        lastReliableSnapshotAt: snapshotNow,
        firstBrokerAbsentAt: sql`coalesce(${arxLivePositionsTable.firstBrokerAbsentAt}, ${snapshotNow})`,
      }).where(and(
        eq(arxLivePositionsTable.userId, conn.userId!),
        eq(arxLivePositionsTable.bridgeConnectionId, conn.id),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
        inArray(arxLivePositionsTable.id, absentIds),
      ));
    }
  } catch (err) {
    req.log.warn({ err }, "sync-live-positions broker-absence evidence tracking failed");
  }

  // ── Broker-REPORTED closes (outcome truth). ───────────────────────────────
  // When the EA reports a closed deal for one of our tickets, the broker has
  // told us plainly that the position is gone AND handed us its own numbers.
  // Stamp closed_at from that report (recording a close the broker already
  // executed — never initiating one) and store the broker figures verbatim.
  // reconcileState is deliberately left NULL, exactly like the ARX close-fill
  // path: this is a confirmed close, not an operator reconciliation.
  const closeReports = parseBrokerCloseReports(b);
  let brokerReportedClosed = 0;
  for (const rep of closeReports) {
    try {
      const stamped = await db.update(arxLivePositionsTable).set({
        closedAt: rep.closedAt ?? snapshotNow,
        brokerCloseReportedAt: snapshotNow,
        brokerClosePrice: rep.brokerClosePrice ?? null,
        brokerRealisedPnl: rep.brokerRealisedPnl ?? null,
        lastSyncedAt: snapshotNow,
      }).where(and(
        eq(arxLivePositionsTable.userId, conn.userId!),
        eq(arxLivePositionsTable.brokerTicket, rep.brokerTicket),
        isNull(arxLivePositionsTable.closedAt),
      )).returning({ id: arxLivePositionsTable.id });
      if (stamped.length > 0) brokerReportedClosed += 1;
    } catch (err) {
      req.log.warn({ err, brokerTicket: rep.brokerTicket }, "broker close report stamp failed");
    }
  }

  // Stamp the bridge's "complete sweep landed" marker on EVERY snapshot,
  // including an EMPTY positions list (broker flat). The live position READ
  // layers use this — NOT row timestamps — as the reliability signal: a
  // stale/missing position row is treated as broker-confirmed-absent only when
  // this marker is recent (a reliable complete sweep excluded it). Stamping on
  // empty pushes is what lets a genuinely flat book clear, while a delayed or
  // absent snapshot leaves the marker stale so every open position stays
  // visible pending confirmation. Best-effort: a failed stamp must not fail the
  // ingest (the upserts above already landed).
  try {
    await db.update(mt5ConnectionTable)
      .set({ lastPositionsSnapshotAt: new Date() })
      .where(eq(mt5ConnectionTable.id, conn.id));
  } catch (err) {
    req.log.warn({ err }, "sync-live-positions snapshot-marker stamp failed");
  }

  // Broker-Side Close Reconciliation Guardrail — DB-WRITE path. Runs ONLY when
  // the policy flag is explicitly enabled (default OFF → dry-run only). When on,
  // it stamps closed_at + reconcileState=RECONCILED_BROKER_ABSENT for rows that
  // satisfy ALL safety conditions (N consecutive reliable absences, min age, no
  // pending ARX close, same user/bridge). Never sends a broker command.
  // Best-effort + fire-and-forget so it cannot slow or fail the ingest.
  if (brokerAbsenceAutoReconcilePolicy.enabled) {
    void (async () => {
      try {
        await runBrokerAbsenceReconcile({ userId: conn.userId!, bridgeConnectionId: conn.id });
      } catch (err) {
        req.log.warn({ err }, "broker-absence auto-reconcile after sync-live-positions failed");
      }
    })();
  }

  // ── Broker-side close OBSERVATION (outcome truth). NOT flag-gated. ─────────
  // Recording the outcome of a position the broker ALREADY closed is an
  // observation, not an action: it sends no broker command, writes no position
  // state on the absence path, and cannot place or relax anything. Gating it
  // behind the auto-reconcile ACTION flag is exactly what let ARX-issued closes
  // (wins, take-profits, trails) be recorded while broker-side stop-losses were
  // not — biasing every realised figure upward. It uses the same evidence bar as
  // the action path, and when the broker gave no numbers it records an honest
  // UNRECONCILED outcome (pnl NULL + typed reason) rather than guessing.
  // Best-effort + fire-and-forget so it can never slow or fail the EA ACK.
  void (async () => {
    try {
      await observeBrokerSideCloses({
        userId: conn.userId!,
        bridgeConnectionId: conn.id,
        reports: closeReports.map((r) => ({
          brokerTicket: r.brokerTicket,
          brokerRealisedPnl: r.brokerRealisedPnl,
          brokerClosePrice: r.brokerClosePrice,
        })),
        now: snapshotNow,
      });
    } catch (err) {
      req.log.warn({ err }, "broker-side close observation after sync-live-positions failed");
    }
  })();

  // Task #1 — live position snapshot drives totalUserUnrealizedPnl; refresh pool.
  void (async () => {
    try {
      const { recomputeMasterPool } = await import("../lib/live/masterBridgePool.js");
      await recomputeMasterPool();
    } catch (err) {
      req.log.warn({ err }, "Master pool recompute after sync-live-positions failed");
    }
  })();
  // Task #333 — instant SSE push. This is the reliable complete broker
  // positions sweep that /me/live/account-stream reads (open positions +
  // floating P/L), so signal this user's stream to rebuild now instead of
  // waiting on its 3s fallback tick. Best-effort; never blocks the EA ACK.
  emitLiveAccountChanged(conn.userId ?? null);
  res.json({
    ok: true,
    upserts,
    received: positions.length,
    reconciledClosed,
    brokerReportedClosed,
    ...LIVE_SAFETY_ENVELOPE,
  });
}

router.post("/mt5/sync-live-positions", bridgeAuthPerUserOnly, (req: AugReq, res) =>
  handleLivePositionsSnapshot(req, res),
);
// EA v1.50 renamed the push endpoint to /positions-snapshot (same payload
// meaning, ticket/sl/tp/openTime field names). Routes to the same ingest so
// real broker positions land in arx_live_positions instead of 404ing.
router.post("/mt5/positions-snapshot", bridgeAuthPerUserOnly, (req: AugReq, res) =>
  handleLivePositionsSnapshot(req, res),
);

// ── POST /api/mt5/pending-snapshot ─────────────────────────────────────────
// EA v1.50 pushes the broker's pending-order list every ~5s. ARX has no
// user-facing live pending-order view yet, but the endpoint MUST exist so the
// EA stops 404ing every cycle. Validate + acknowledge the count honestly;
// never fabricate or persist a phantom order.
router.post("/mt5/pending-snapshot", bridgeAuthPerUserOnly, async (req: AugReq, res) => {
  const conn = requireLiveBridge(req, res);
  if (!conn) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pending = Array.isArray(b["pending"]) ? (b["pending"] as unknown[]) : [];
  res.json({ ok: true, received: pending.length, ...LIVE_SAFETY_ENVELOPE });
});

export default router;
