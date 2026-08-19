// Phase B — Live trading routes (per-user).
//
// SAFETY:
// - The dispatch endpoint now calls the 15-gate Phase B evaluator. On PASS
//   the row transitions to SENT_TO_MT5_LIVE and waits for EA pickup. On
//   BLOCKED the row goes to LIVE_BLOCKED with the exact failing reason.
// - The legacy literal `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is still
//   appended to `blockReasons` whenever the server master switch
//   `ARX_LIVE_BROKER_EXECUTION_ENABLED` is false. The CI guard
//   `live-trading-readiness-lock` (scoped to `lib/liveTrading/`) is
//   unaffected — Phase B lives in `lib/live/`.
// - Controlled live test endpoint (`/controlled-test-trigger`) is the ONLY
//   server-side path that arranges a fresh draft → confirm → dispatch in
//   one POST. It is gated by an exact typed phrase and pins symbol=EURUSD
//   + volume=0.01. It NEVER auto-runs; the UI must call it explicitly.
//
// Mount path: /api/me/live/*

import { Router, type Request, type Response } from "express";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  evaluateLiveArmingGate,
  armLiveForUser,
  disarmLiveForUser,
  engageKillSwitchForUser,
  releaseKillSwitchForUser,
  getMyArming,
  LIVE_CONFIRMATION_PHRASE,
  ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT,
} from "../lib/live/liveArming.js";
import {
  createLiveDraft,
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
  cancelLiveCommand,
  listMyLiveCommands,
  getMyLiveCommand,
  getOrCreateUserSettings,
  updateUserSettings,
} from "../lib/live/liveCommandPipeline.js";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import {
  isSnapshotReliable,
  classifyRow,
  POSITION_SYNC_INCOMPLETE_WARNING,
} from "../lib/live/positionFreshness.js";
import { getUserModeScope, modeScopeEnvelope } from "../lib/modeScope/getUserModeScope.js";
import { resolveLiveCloseConfirmation } from "../lib/live/closeConfirmation.js";
import {
  resolveLivePositionVisibility,
  ACCOUNT_NOT_IN_LIVE_MODE,
} from "../lib/modeScope/livePositionVisibility.js";
import { db, arxLiveCommandsTable, arxLivePositionsTable, mt5ConnectionTable } from "@workspace/db";
import {
  composeInvestorBalance,
  fetchInvestorBalanceParts,
  toInvestorLiveBalanceWire,
} from "../lib/live/investorLiveBalance.js";

const router = Router();

const CONTROLLED_LIVE_TEST_PHRASE = "ENABLE LIVE TRADING" as const;

function uid(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  return u?.id ?? null;
}
function isAdmin(req: Request): boolean {
  const u = (req as Request & { authUser?: { role?: string } }).authUser;
  return u?.role === "ADMIN" || u?.role === "OWNER";
}

const SAFETY_ENVELOPE = {
  safetyMode: "phase_b_live_runtime_gated" as const,
  liveBrokerExecutionEnabled: false as boolean,
  liveDispatchEvaluator: "evaluateLivePhaseBDispatchGate" as const,
  liveExecutionDefaultDeny: true as const,
};
function envelope() {
  return { ...SAFETY_ENVELOPE, liveBrokerExecutionEnabled: liveBrokerExecutionEnabled() };
}

// ── Arming ─────────────────────────────────────────────────────────────────

router.post("/me/live/arming/preview", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const b = req.body ?? {};
  const gate = await evaluateLiveArmingGate({
    userId,
    isAdmin: isAdmin(req),
    confirmationPhrase: String(b.confirmationPhrase ?? ""),
    riskAcknowledged: b.riskAcknowledged === true,
    accountNumberConfirmed: String(b.accountNumberConfirmed ?? ""),
    brokerConfirmed: b.brokerConfirmed != null ? String(b.brokerConfirmed) : undefined,
    serverConfirmed: b.serverConfirmed != null ? String(b.serverConfirmed) : undefined,
    brokerServerConfirmed: b.brokerServerConfirmed != null ? String(b.brokerServerConfirmed) : undefined,
    maxLotConfirmed: Number(b.maxLotConfirmed ?? 0),
    dailyLossLimitConfirmed: Number(b.dailyLossLimitConfirmed ?? 0),
    killSwitchAcknowledged: b.killSwitchAcknowledged === true,
  });
  // phraseDebug only goes back to admin sessions.
  const gateOut = isAdmin(req) ? gate : { ...gate, phraseDebug: undefined };
  res.json({ gate: gateOut, confirmationPhrase: LIVE_CONFIRMATION_PHRASE, ...envelope() });
});

router.post("/me/live/arming/arm", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const b = req.body ?? {};
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;
  const result = await armLiveForUser({
    userId, isAdmin: isAdmin(req),
    confirmationPhrase: String(b.confirmationPhrase ?? ""),
    riskAcknowledged: b.riskAcknowledged === true,
    accountNumberConfirmed: String(b.accountNumberConfirmed ?? ""),
    brokerConfirmed: b.brokerConfirmed != null ? String(b.brokerConfirmed) : undefined,
    serverConfirmed: b.serverConfirmed != null ? String(b.serverConfirmed) : undefined,
    brokerServerConfirmed: b.brokerServerConfirmed != null ? String(b.brokerServerConfirmed) : undefined,
    maxLotConfirmed: Number(b.maxLotConfirmed ?? 0),
    dailyLossLimitConfirmed: Number(b.dailyLossLimitConfirmed ?? 0),
    killSwitchAcknowledged: b.killSwitchAcknowledged === true,
    ip,
  });
  // phraseDebug only goes back to admin sessions (matches preview behaviour).
  const sanitized = isAdmin(req) || result.gate == null
    ? result
    : { ...result, gate: { ...result.gate, phraseDebug: undefined } };
  res.status(result.ok ? 200 : 409).json({ ...sanitized, ...envelope() });
});

router.post("/me/live/arming/disarm", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const reason = String((req.body ?? {}).reason ?? "user_disarm");
  const result = await disarmLiveForUser({ userId, reason });
  res.json({ ...result, ...envelope() });
});

router.get("/me/live/arming", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const arming = await getMyArming(userId);
  res.json({
    arming: arming ? {
      isArmed: arming.isArmed,
      armedAt: arming.armedAt,
      accountNumberConfirmed: arming.accountNumberConfirmed,
      brokerServerConfirmed: arming.brokerServerConfirmed,
      maxLotConfirmed: arming.maxLotConfirmed,
      dailyLossLimitConfirmed: arming.dailyLossLimitConfirmed,
      killSwitchEngaged: arming.killSwitchEngaged,
      killSwitchEngagedAt: arming.killSwitchEngagedAt,
      killSwitchReason: arming.killSwitchReason,
      disarmedAt: arming.disarmedAt,
      disarmedReason: arming.disarmedReason,
    } : null,
    confirmationPhrase: LIVE_CONFIRMATION_PHRASE,
    hardWeeklyDrawdownPct: ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT,
    ...envelope(),
  });
});

// ── Kill switch ────────────────────────────────────────────────────────────

router.post("/me/live/kill-switch/engage", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const reason = String((req.body ?? {}).reason ?? "manual_engage");
  const result = await engageKillSwitchForUser({ userId, reason });
  res.json({ ...result, ...envelope() });
});

router.post("/me/live/kill-switch/release", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const result = await releaseKillSwitchForUser({ userId });
  res.json({ ...result, ...envelope() });
});

// ── Live commands ──────────────────────────────────────────────────────────

router.post("/me/live/commands", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const b = req.body ?? {};
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;
  const result = await createLiveDraft({
    userId,
    commandType: b.commandType,
    symbol: String(b.symbol ?? ""),
    side: b.side,
    orderType: String(b.orderType ?? "MARKET_BUY"),
    requestedVolume: Number(b.requestedVolume ?? b.volume ?? 0),
    stopLoss: b.stopLoss != null ? Number(b.stopLoss) : null,
    takeProfit: b.takeProfit != null ? Number(b.takeProfit) : null,
    sourcePage: b.sourcePage ?? b.source ?? "LIVE_TRADE_TICKET",
    rubyExplanationSummary: b.rubyExplanationSummary ?? null,
    payload: b.payload ?? {},
    ip,
  });
  res.status(result.ok ? 201 : 409).json({ ...result, ...envelope() });
});

router.post("/me/live/commands/:commandId/confirm", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const result = await confirmLiveCommand({ userId, commandId: String(req.params.commandId ?? "") });
  res.status(result.ok ? 200 : 409).json({ ...result, ...envelope() });
});

router.post("/me/live/commands/:commandId/dispatch", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const result = await dispatchLiveCommand({ userId, commandId: String(req.params.commandId ?? "") });
  // Phase B: result.ok may be true (PASS path → SENT_TO_MT5_LIVE) or false
  // (BLOCKED with the exact failing gate reason). Surface 200 either way so
  // the UI renders the full state-machine outcome including LIVE_BLOCKED.
  res.status(200).json({ ...result, ...envelope() });
});

router.post("/me/live/commands/:commandId/cancel", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const reason = String((req.body ?? {}).reason ?? "user_cancel");
  const result = await cancelLiveCommand({ userId, commandId: String(req.params.commandId ?? ""), reason });
  res.status(result.ok ? 200 : 409).json({ ...result, ...envelope() });
});

router.get("/me/live/commands", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const items = await listMyLiveCommands({ userId, limit });
  res.json({ items, count: items.length, ...envelope() });
});

router.get("/me/live/commands/:commandId", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const row = await getMyLiveCommand(userId, String(req.params.commandId ?? ""));
  if (!row) { res.status(404).json({ error: "COMMAND_NOT_FOUND" }); return; }
  res.json({ command: row, ...envelope() });
});

// ── Live positions — Phase B reads `arx_live_positions` (EA-synced) ────────

router.get("/me/live/positions", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  // ── Canonical live-position visibility rule (shared with
  //    /api/me/positions/all). Live rows are shown to the authenticated owner
  //    ONLY when the resolved account mode is LIVE_SHARED. This keeps every
  //    ARX surface in agreement: the same real broker position can never be
  //    visible on one page and silently empty on another. getUserModeScope is
  //    fail-safe (PAPER on any internal error), so a degraded resolver hides
  //    live rows rather than guessing they are live. READ-ONLY.
  const callerIsAdmin = isAdmin(req);
  const scope = await getUserModeScope(userId, { isAdmin: callerIsAdmin });
  const { includeLive, notLiveReason } = resolveLivePositionVisibility(scope.currentAccountMode);
  // Admin/operator diagnostic override — `?includeStale=1` is an admin-only
  // inspection switch (it already surfaced stale rows). For a real admin it
  // additionally bypasses the mode gate so an operator can inspect a user's
  // broker book regardless of the user's current display mode. A regular user
  // passing includeStale never bypasses the mode gate.
  const adminDiagnosticView = callerIsAdmin &&
    (req.query.includeStale === "1" || req.query.includeStale === "true");

  if (!includeLive && !adminDiagnosticView) {
    // Not in live mode → return the canonical safe empty state with the shared
    // reason, instead of a bare empty list that the UI would render as
    // "0 positions". The frontend maps notLiveReason to user-safe copy and
    // never shows the raw token.
    res.json({
      items: [],
      count: 0,
      snapshotWarning: null,
      snapshotReliable: false,
      notLiveReason: notLiveReason ?? ACCOUNT_NOT_IN_LIVE_MODE,
      ...modeScopeEnvelope(scope),
      ...envelope(),
    });
    return;
  }

  // Admin diagnostics may request stale rows too via ?includeStale=1.
  const includeStale = req.query.includeStale === "1" || req.query.includeStale === "true";
  const allRows = await db.select().from(arxLivePositionsTable)
    .where(eq(arxLivePositionsTable.userId, userId));

  // Position visibility rule (see positionFreshness.ts). A stale lastSyncedAt
  // NEVER hides a real open position on its own. A stale/missing row is only
  // dropped from the default open view when we ALSO have a reliable recent
  // snapshot that excluded it (broker-confirmed-absent → closed outside ARX).
  // If the latest snapshot is itself stale/incomplete (bridge lagging, EA
  // offline), we cannot conclude closure: ALL open positions stay visible and
  // are flagged "broker confirmation pending". `closedAt` (set only on a
  // broker-confirmed CLOSE command) is the single authoritative closed signal.
  // READ-ONLY — nothing is mutated or auto-closed here (ALERT_ONLY).
  const STALE_MS = 90_000; // 90s — comfortably longer than the EA sync cadence
  const now = Date.now();
  // Reliability is driven by the bridge's "complete sweep landed" marker
  // (last_positions_snapshot_at), stamped on EVERY ingest including an empty
  // book — NOT by the newest row timestamp (which would decay to unreliable on
  // a flat broker and pin closed rows on screen). Max across the user's
  // non-revoked, non-demo bridges so any live bridge counts.
  const snapMarkerRows = await db
    .select({ t: sql<string | null>`max(${mt5ConnectionTable.lastPositionsSnapshotAt})` })
    .from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      ne(mt5ConnectionTable.status, "revoked"),
      or(isNull(mt5ConnectionTable.accountType), ne(mt5ConnectionTable.accountType, "demo")),
    ));
  const snapshotAtMs = snapMarkerRows[0]?.t ? new Date(snapMarkerRows[0].t).getTime() : null;
  const snapshotReliable = isSnapshotReliable(snapshotAtMs, STALE_MS, now);
  const classifyOf = (r: (typeof allRows)[number]) =>
    classifyRow(r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null, { windowMs: STALE_MS, now, snapshotReliable });

  const rows = includeStale ? allRows : allRows.filter((r) => {
    if (r.closedAt) return false; // closed rows never shown in open view
    // Hide ONLY broker-confirmed-absent ghosts (reliable snapshot excluded them).
    return !classifyOf(r).brokerConfirmedAbsent;
  });
  // Map DB shape → UI-stable shape (kept compatible with existing
  // OpenLivePositions component fields). Both EA snapshot paths (v1.27
  // sync-live-positions and v1.50 positions-snapshot) land in
  // arx_live_positions, so a single read covers the full open book — including
  // the v1.50 EURUSD fill. Per-row honesty:
  //   • positionSource/brokerDetectedOnly come from whether the row links to a
  //     LIVE_FILLED ARX command (sourceCommandId). No link → the position
  //     exists at the broker but was opened outside the ARX live ticket flow.
  //   • freshness/confirmation reflect whether the row was re-confirmed by the
  //     latest snapshot. STALE/MISSING rows stay visible (confirmation pending)
  //     while the snapshot is unreliable, and only drop out (above) once a
  //     reliable snapshot confirms them absent.
  const items = rows.map((r) => {
    const cls = classifyOf(r);
    const linked = r.sourceCommandId != null && r.sourceCommandId !== "";
    return {
      id: r.id,
      brokerPositionId: r.brokerTicket,
      symbol: r.symbol,
      direction: r.side,
      lotSize: Number(r.volume),
      entryPrice: Number(r.entryPrice),
      currentPrice: r.currentPrice != null ? Number(r.currentPrice) : null,
      stopLoss: r.stopLoss != null ? Number(r.stopLoss) : null,
      takeProfit: r.takeProfit != null ? Number(r.takeProfit) : null,
      unrealizedProfitLoss: r.floatingPl != null ? Number(r.floatingPl) : null,
      openedAt: r.openedAt,
      status: r.closedAt ? "CLOSED" : "OPEN",
      sourceCommandId: r.sourceCommandId,
      lastSyncedAt: r.lastSyncedAt,
      positionSource: (linked ? "live_command" : "broker_sync") as "live_command" | "broker_sync",
      brokerDetectedOnly: !linked,
      freshness: cls.freshness,
      confirmation: cls.confirmation,
    };
  });

  // Honest snapshot banner: when the latest EA snapshot is unreliable (no
  // recent complete push) but open positions exist, the open book may not match
  // the broker yet. Surface the required "waiting for broker confirmation" copy
  // rather than hiding the positions. READ-ONLY.
  const snapshotWarning: string | null =
    !snapshotReliable && rows.some((r) => !r.closedAt) ? POSITION_SYNC_INCOMPLETE_WARNING : null;

  res.json({ items, count: items.length, snapshotWarning, snapshotReliable, notLiveReason: null, ...modeScopeEnvelope(scope), ...envelope() });
});

// Close a live position by ticket — creates a CLOSE_LIVE_POSITION command,
// auto-confirms, and dispatches through the 15-gate Phase B evaluator.
router.post("/me/live/positions/:ticket/close", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const ticket = String(req.params.ticket ?? "");
  req.log.info({ action: "CLOSE_TRADE_REQUESTED", userId, ticket, scope: "live" }, "trade.close.requested");
  const rows = await db.select().from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), eq(arxLivePositionsTable.brokerTicket, ticket)))
    .limit(1);
  const pos = rows[0];
  if (!pos) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }

  const draft = await createLiveOpsDraft({
    userId, commandType: "CLOSE_LIVE_POSITION",
    brokerTicket: ticket, symbol: pos.symbol, side: pos.side as "BUY" | "SELL",
    volume: Number(pos.volume), sourcePage: "LIVE_POSITIONS_CLOSE",
  });
  if (!draft.ok) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "draft", reason: (draft as { error?: string }).error ?? null }, "trade.close.blocked");
    res.status(409).json({ ...draft, ...envelope() }); return;
  }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "confirm", reason: (conf as { error?: string }).error ?? null }, "trade.close.blocked");
    res.status(409).json({ ...conf, ...envelope() }); return;
  }
  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  if ((disp as { ok?: boolean }).ok === false) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "dispatch", reason: (disp as { primaryReason?: string }).primaryReason ?? null }, "trade.close.blocked");
  } else {
    req.log.info({ action: "COMMAND_SUBMITTED_AFTER_APPROVAL", userId, ticket, commandType: "CLOSE_LIVE_POSITION" }, "trade.close.dispatched");
  }
  res.json({ ...disp, ...envelope() });
});

/**
 * POST /me/live/positions/close-all — reduce-only "close every open live
 * position". Iterates each open `arx_live_positions` row for the caller,
 * funnels each one through the same `createLiveOpsDraft → confirm →
 * dispatch` path as the single-ticket close. The 16-gate evaluator runs
 * per-ticket; CLOSE commands bypass MISSING_STOP_LOSS via the existing
 * isOpsCommand bypass. NOTE: kill-switch still blocks at preflight —
 * even reduce-only ops require user-armed + kill-switch off (see
 * `createLiveOpsDraft`). One-click-toggle's reduceOnlyCloseAllowed flag
 * is informational only; the gate truth is in the pipeline.
 */
router.post("/me/live/positions/close-all", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const open = await db.select().from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      isNull(arxLivePositionsTable.closedAt),
    ));
  req.log.info({ action: "CLOSE_ALL_REQUESTED", userId, openCount: open.length }, "trade.close-all.requested");
  const results: Array<{ ticket: string; ok: boolean; reason?: string }> = [];
  for (const pos of open) {
    const ticket = pos.brokerTicket ?? "";
    if (!ticket) {
      results.push({ ticket: String(pos.id), ok: false, reason: "NO_BROKER_TICKET" });
      continue;
    }
    const draft = await createLiveOpsDraft({
      userId, commandType: "CLOSE_LIVE_POSITION",
      brokerTicket: ticket, symbol: pos.symbol, side: pos.side as "BUY" | "SELL",
      volume: Number(pos.volume), sourcePage: "LIVE_POSITIONS_CLOSE_ALL",
    });
    if (!draft.ok) {
      results.push({ ticket, ok: false, reason: (draft as { reason?: string }).reason });
      continue;
    }
    const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
    if (!conf.ok) {
      results.push({ ticket, ok: false, reason: (conf as { reason?: string }).reason });
      continue;
    }
    const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
    const ok = (disp as { ok?: boolean }).ok === true;
    results.push({ ticket, ok, reason: ok ? undefined : ((disp as { primaryReason?: string; reason?: string }).primaryReason ?? (disp as { reason?: string }).reason) });
  }
  const closed = results.filter((r) => r.ok).length;
  req.log.info({ action: "CLOSE_ALL_COMPLETED", userId, total: results.length, closed }, "trade.close-all.completed");
  res.json({ ok: true, total: results.length, closed, results, ...envelope() });
});

router.post("/me/live/positions/:ticket/modify", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const ticket = String(req.params.ticket ?? "");
  const b = req.body ?? {};
  const newSL = b.newStopLoss != null ? Number(b.newStopLoss) : null;
  const newTP = b.newTakeProfit != null ? Number(b.newTakeProfit) : null;
  req.log.info({ action: "SLTP_EDIT_REQUESTED", userId, ticket, hasNewSL: newSL != null, hasNewTP: newTP != null }, "trade.modify.requested");
  if (newSL == null && newTP == null) {
    res.status(400).json({ error: "NO_CHANGES", detail: "Provide newStopLoss or newTakeProfit" }); return;
  }
  const rows = await db.select().from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), eq(arxLivePositionsTable.brokerTicket, ticket)))
    .limit(1);
  const pos = rows[0];
  if (!pos) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }

  const draft = await createLiveOpsDraft({
    userId, commandType: "MODIFY_LIVE_SLTP",
    brokerTicket: ticket, symbol: pos.symbol, side: pos.side as "BUY" | "SELL",
    volume: Number(pos.volume), newStopLoss: newSL, newTakeProfit: newTP,
    sourcePage: "LIVE_POSITIONS_MODIFY",
  });
  if (!draft.ok) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "draft", reason: (draft as { error?: string }).error ?? null }, "trade.modify.blocked");
    res.status(409).json({ ...draft, ...envelope() }); return;
  }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "confirm", reason: (conf as { error?: string }).error ?? null }, "trade.modify.blocked");
    res.status(409).json({ ...conf, ...envelope() }); return;
  }
  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  if ((disp as { ok?: boolean }).ok === false) {
    req.log.warn({ action: "SAFETY_GATE_BLOCKED", userId, ticket, stage: "dispatch", reason: (disp as { primaryReason?: string }).primaryReason ?? null }, "trade.modify.blocked");
  } else {
    req.log.info({ action: "COMMAND_SUBMITTED_AFTER_APPROVAL", userId, ticket, commandType: "MODIFY_LIVE_SLTP" }, "trade.modify.dispatched");
  }
  res.json({ ...disp, ...envelope() });
});

// ── Controlled live test — EURUSD 0.01, typed-phrase gated, never auto-runs.
router.post("/me/live/controlled-test-trigger", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  // OWNER-only — this endpoint sends real live money
  const role = (req as unknown as { authUser?: { role?: string } }).authUser?.role;
  if (role !== "OWNER") {
    res.status(403).json({ error: "OWNER_REQUIRED", detail: "Only the account OWNER can submit the final live test." });
    return;
  }
  const b = req.body ?? {};
  if (String(b.confirmationPhrase ?? "") !== CONTROLLED_LIVE_TEST_PHRASE) {
    res.status(400).json({
      error: "CONFIRMATION_PHRASE_MISMATCH",
      detail: `Type exactly: ${CONTROLLED_LIVE_TEST_PHRASE}`,
      requiredPhrase: CONTROLLED_LIVE_TEST_PHRASE,
    });
    return;
  }
  const side = b.side === "SELL" ? "SELL" : "BUY";
  const sl = b.stopLoss != null ? Number(b.stopLoss) : null;
  if (sl == null || sl <= 0) {
    res.status(400).json({ error: "STOP_LOSS_REQUIRED", detail: "Controlled live test requires explicit SL" });
    return;
  }
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;
  const draft = await createLiveDraft({
    userId,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    symbol: "EURUSD",          // pinned
    side, orderType: side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
    requestedVolume: 0.01,     // pinned
    stopLoss: sl,
    takeProfit: b.takeProfit != null ? Number(b.takeProfit) : null,
    sourcePage: "CONTROLLED_LIVE_TEST",
    rubyExplanationSummary: "Controlled live test trigger (EURUSD 0.01)",
    payload: { controlledTest: true },
    ip,
  });
  if (!draft.ok) { res.status(409).json({ ...draft, ...envelope() }); return; }
  const conf = await confirmLiveCommand({ userId, commandId: draft.command.commandId });
  if (!conf.ok) { res.status(409).json({ ...conf, ...envelope() }); return; }
  const disp = await dispatchLiveCommand({ userId, commandId: draft.command.commandId });
  res.json({ ...disp, commandId: draft.command.commandId, ...envelope() });
});

// ── Command status poll (for live test result display) ─────────────────────
router.get("/me/live/command-status/:commandId", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const commandId = String(req.params.commandId ?? "");
  if (!commandId) { res.status(400).json({ error: "COMMAND_ID_REQUIRED" }); return; }
  const rows = await db.select()
    .from(arxLiveCommandsTable)
    .where(and(
      eq(arxLiveCommandsTable.commandId, commandId),
      eq(arxLiveCommandsTable.userId, userId),
    ))
    .limit(1);
  const cmd = rows[0];
  if (!cmd) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  // Honest live-command status for the UI's pending → executed/rejected
  // tracker. Columns are read by their REAL schema names: a confirmed MT5
  // execution is `brokerTicket` (NOT the never-existed `orderTicket`), and
  // the EA pickup time is `pickedByEaAt` (NOT `pulledAt`). `brokerTicket`
  // is only ever non-null when the EA reported a real LIVE_FILLED, so the
  // frontend can gate the word "executed" on a genuine broker ticket and
  // never imply execution from a mere dispatch.

  // Task #402 — for a CLOSE command, a terminal-success status (LIVE_FILLED,
  // retcode 10009) is NOT proof the position closed. Resolve a real
  // `closeConfirmed` verdict the same way the runtime resolver does: the
  // target position's `closedAt` must be stamped AND the command must carry no
  // error reason — INDEPENDENT of retcode. The frontend gates "closed" copy on
  // this so a phantom close never surfaces to the user as done.
  let closeConfirmed: boolean | null = null;
  let closeConfirmationReason: string | null = null;
  if (cmd.commandType === "CLOSE_LIVE_POSITION") {
    const payload = (cmd.payload ?? null) as Record<string, unknown> | null;
    const targetTicket =
      cmd.brokerTicket ??
      (typeof payload?.["brokerTicket"] === "string" ? String(payload["brokerTicket"]) : null);
    let positionClosedAt: Date | string | null = null;
    if (targetTicket) {
      const posRows = await db.select({ closedAt: arxLivePositionsTable.closedAt })
        .from(arxLivePositionsTable)
        .where(and(
          eq(arxLivePositionsTable.userId, userId),
          eq(arxLivePositionsTable.brokerTicket, targetTicket),
        ))
        .limit(1);
      positionClosedAt = posRows[0]?.closedAt ?? null;
    }
    const verdict = resolveLiveCloseConfirmation({
      positionClosedAt,
      commandStatus: cmd.status,
      rejectionReason: cmd.rejectionReason,
      mt5Retcode: cmd.mt5Retcode,
    });
    closeConfirmed = verdict.closeConfirmed;
    closeConfirmationReason = verdict.reason;
  }

  res.json({
    status:          cmd.status ?? null,
    commandType:     cmd.commandType ?? null,
    brokerTicket:    cmd.brokerTicket ?? null,
    fillPrice:       cmd.fillPrice ?? null,
    mt5Retcode:      cmd.mt5Retcode ?? null,
    brokerMessage:   cmd.brokerMessage ?? null,
    rejectionReason: cmd.rejectionReason ?? null,
    pickedByEaAt:    cmd.pickedByEaAt ?? null,
    filledAt:        cmd.filledAt ?? null,
    // Close-evidence verdict — null for non-CLOSE commands (not applicable).
    closeConfirmed,
    closeConfirmationReason,
  });
});

// ── User trading-style settings ────────────────────────────────────────────

router.get("/me/live/settings", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const settings = await getOrCreateUserSettings(userId);
  res.json({ settings, hardWeeklyDrawdownPct: ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT, ...envelope() });
});

router.put("/me/live/settings", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const b = req.body ?? {};
  // SAFETY: `requireStopLoss` is intentionally NOT user-mutable. Allowing
  // a user to disable their own SL requirement would void the Phase B
  // MISSING_STOP_LOSS gate. The flag defaults to true at the schema layer
  // and may only be overridden by an admin via `adminAllowNoStopLoss`
  // (admin-only path, not exposed on this endpoint). Any `requireStopLoss`
  // field in the request body is silently dropped.
  const updated = await updateUserSettings({
    userId,
    weeklyDrawdownCeilingPct: b.weeklyDrawdownCeilingPct != null ? Number(b.weeklyDrawdownCeilingPct) : undefined,
    dailyLossLimitUsd: b.dailyLossLimitUsd != null ? Number(b.dailyLossLimitUsd) : undefined,
    maxLotPerMarket: b.maxLotPerMarket,
    allowedSymbols: Array.isArray(b.allowedSymbols) ? b.allowedSymbols.map(String) : undefined,
  });
  res.json({ settings: updated, hardWeeklyDrawdownPct: ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT, ...envelope() });
});

// ── Live EA heartbeat debug — surfaces the freshest non-revoked bridge for
// this user with v1.27 live-readiness fields + an explicit MOCK warning.
// Read-only. No safety state can be changed from this endpoint.
router.get("/me/live/bridge-debug", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const rows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId));
  const nonRevoked = rows.filter((r) => !r.tokenRevokedAt);
  const byFreshness = (a: typeof nonRevoked[number], b: typeof nonRevoked[number]) => {
    const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
    const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
    return bh - ah;
  };
  // Selection priority: freshest real LIVE bridge → freshest real DEMO bridge
  // → freshest MOCK row (so the UI can show "you only have a MOCK placeholder").
  const liveReal = nonRevoked.filter((r) => r.mode === "LIVE").sort(byFreshness)[0] ?? null;
  const demoReal = nonRevoked.filter((r) => r.mode === "DEMO").sort(byFreshness)[0] ?? null;
  const anyMock  = nonRevoked.filter((r) => r.mode === "MOCK").sort(byFreshness)[0] ?? null;
  const picked = liveReal ?? demoReal ?? anyMock ?? null;

  if (!picked) {
    res.json({
      bridge: null,
      bridgeKind: "NONE" as const,
      message: "No MT5 bridge connection exists for this user. Create one in MT5 Setup → Bridge Tokens.",
      counts: { live: 0, demo: 0, mock: 0 },
      ...envelope(),
    });
    return;
  }
  const caps = (picked.capabilities ?? {}) as {
    eaInputs?: Record<string, unknown>;
    bridgeVersion?: string;
    v150?: {
      normalized?: Record<string, boolean>;
      unmapped?: string[];
      eaVersion?: string | null;
      eaProtocol?: string | null;
      lastCapabilitySeenAt?: string | null;
    };
  };
  const ea = (caps.eaInputs ?? {}) as Record<string, unknown>;
  const hbAgeSec = picked.lastHeartbeat
    ? Math.max(0, Math.floor((Date.now() - new Date(picked.lastHeartbeat).getTime()) / 1000))
    : null;
  const bridgeKind = picked.mode === "LIVE" ? ("REAL_LIVE" as const)
    : picked.mode === "DEMO" ? ("REAL_DEMO" as const)
    : ("MOCK" as const);
  res.json({
    bridge: {
      id: picked.id,
      mode: picked.mode,
      bridgeKind,
      accountType: picked.accountType,
      accountNumber: picked.accountNumber,
      brokerName: picked.brokerName,
      serverName: picked.serverName,
      eaVersion: picked.eaVersion,
      bridgeVersion: caps.bridgeVersion ?? null,
      lastHeartbeatAt: picked.lastHeartbeat?.toISOString() ?? null,
      heartbeatAgeSeconds: hbAgeSec,
      heartbeatFresh: hbAgeSec !== null && hbAgeSec <= 15,
      readOnlyMode: picked.readOnlyMode,
      // EA v1.27 reported runtime fields (null = EA build pre-dates the
      // heartbeat extension or did not include the field on this poll)
      eaInputs: {
        readOnlyMode: typeof ea["readOnlyMode"] === "boolean" ? ea["readOnlyMode"] : null,
        enableDemoExecution: typeof ea["enableDemoExecution"] === "boolean" ? ea["enableDemoExecution"] : null,
        enableLiveExecution: typeof ea["enableLiveExecution"] === "boolean" ? ea["enableLiveExecution"] : null,
        terminalConnected: typeof ea["terminalConnected"] === "boolean" ? ea["terminalConnected"] : null,
        algoTradingAllowed: typeof ea["algoTradingAllowed"] === "boolean" ? ea["algoTradingAllowed"] : null,
        maxLiveLot: typeof ea["maxLiveLot"] === "number" ? ea["maxLiveLot"] : null,
        reportedAt: typeof ea["reportedAt"] === "string" ? ea["reportedAt"] : null,
      },
      // T033 Phase 10 — v1.50 normalized capabilities for frontend action
      // gating. `null` when the connected EA is pre-v1.50 (never reported the
      // v1.50 vocabulary). The UI hides/disables actions whose capability is
      // false, and shows an "EA update required" hint when capabilities is null
      // but the EA is attached. Unknown/missing caps default to absent → the UI
      // treats absent as "not supported" (safe: never shows a dead button).
      capabilities: caps.v150?.normalized ?? null,
      capabilityMeta: caps.v150
        ? {
            eaVersion: caps.v150.eaVersion ?? picked.eaVersion ?? null,
            eaProtocol: caps.v150.eaProtocol ?? null,
            unmapped: caps.v150.unmapped ?? [],
            lastSeenAt: caps.v150.lastCapabilitySeenAt ?? null,
            v150Aware: true,
          }
        : { eaVersion: picked.eaVersion ?? null, eaProtocol: null, unmapped: [], lastSeenAt: null, v150Aware: false },
    },
    bridgeKind,
    counts: {
      live: nonRevoked.filter((r) => r.mode === "LIVE").length,
      demo: nonRevoked.filter((r) => r.mode === "DEMO").length,
      mock: nonRevoked.filter((r) => r.mode === "MOCK").length,
    },
    ...envelope(),
  });
});

// EA configuration helper — exposes the exact server base URL + header name
// the EA should use, plus tokenLast4 of the freshest non-revoked bridge for
// disambiguation. NEVER returns the raw token (raw token is shown exactly
// once at /me/mt5-connections POST creation and never re-served).
router.get("/me/live/ea-inputs", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const rows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId));
  const nonRevoked = rows.filter((r) => !r.tokenRevokedAt);
  const fresh = nonRevoked
    .slice()
    .sort((a, b) => {
      const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      return bh - ah;
    })[0] ?? null;
  const protoHeader = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const proto = protoHeader ?? req.protocol ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host") ?? "";
  const serverBaseUrl = host ? `${proto}://${host}` : "";
  res.json({
    serverBaseUrl,
    heartbeatEndpoint: `${serverBaseUrl}/api/mt5/heartbeat`,
    bridgeTokenHeader: "X-MT5-Bridge-Token",
    tokenLast4: fresh?.tokenLast4 ?? null,
    bridgeConnectionId: fresh?.id ?? null,
    rawTokenPolicy: "Raw tokens are shown exactly once at creation and never re-served. To rotate, create a new connection in MT5 Setup.",
    requiredEaInputs: {
      ServerBaseUrl: serverBaseUrl,
      BridgeToken: "<paste raw token from MT5 Setup at creation time>",
      EnableLiveExecution: false,
      MaxLiveLot: 0.01,
      ReadOnlyMode: true,
    },
    note: "ARX_LIVE_BROKER_EXECUTION_ENABLED on the server, plus EnableLiveExecution=true on the EA, plus all 16 Phase B gates passing, are all required before a live order can be dispatched.",
    ...envelope(),
  });
});

// ── Composite live-bridge refresh snapshot ─────────────────────────────────
//
// GET /me/live/refresh-snapshot — read-only composite that composes the SAME
// builders used by /me/live/account-stream into a single response suitable for
// `useLiveBridgeRefresh` polling (fallback and manual refresh). Returns:
//   • bridgeState — heartbeat age classification (live/delayed/stale/offline)
//   • account block (balance, equity, margin, openPL, openPositionsCount)
//   • positions — open live positions (same mode-scope gate as account-stream)
//   • live — canonical investor balance block (same builder as SSE stream)
//   • reconciliation — light summary (ghost count, open-count parity)
//   • freshness and notLiveReason matching the SSE contract
//
// HONESTY RULES:
//   - A stale/offline bridge does NOT close or modify any position.
//   - All numeric fields are null when the EA has not delivered them yet.
//   - bridgeState.state reflects real heartbeat age, never fabricated as "live".
router.get("/me/live/refresh-snapshot", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const callerIsAdmin = isAdmin(req);

  const { buildLiveAccountSnapshot } = await import("../lib/live/liveAccountSnapshot.js");

  // Bridge state — classify from the freshest non-revoked connection's heartbeat.
  const connRows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId));
  const nonRevoked = connRows.filter((r) => !r.tokenRevokedAt);
  const freshestConn = nonRevoked
    .slice()
    .sort((a, b) => {
      const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      return bh - ah;
    })[0] ?? null;

  const now = Date.now();
  let bridgeState: {
    connected: boolean;
    state: "live" | "delayed" | "stale" | "offline";
    stateReason: string | null;
    heartbeatAgeMs: number | null;
    eaVersion: string | null;
    lastHeartbeatAt: string | null;
  };

  if (!freshestConn) {
    bridgeState = { connected: false, state: "offline", stateReason: "No bridge connection", heartbeatAgeMs: null, eaVersion: null, lastHeartbeatAt: null };
  } else {
    const hbAt = freshestConn.lastHeartbeat ? new Date(freshestConn.lastHeartbeat).getTime() : null;
    const ageMs = hbAt != null ? Math.max(0, now - hbAt) : null;
    let state: "live" | "delayed" | "stale" | "offline";
    let stateReason: string | null = null;
    if (ageMs == null) {
      state = "stale"; stateReason = "Bridge has never sent a heartbeat";
    } else if (ageMs <= 15_000) {
      state = "live";
    } else if (ageMs <= 60_000) {
      state = "delayed"; stateReason = `Last heartbeat ${Math.round(ageMs / 1000)}s ago`;
    } else {
      state = "stale"; stateReason = `Last heartbeat ${Math.round(ageMs / 1000)}s ago`;
    }
    bridgeState = {
      connected: true,
      state,
      stateReason,
      heartbeatAgeMs: ageMs,
      eaVersion: freshestConn.eaVersion ?? null,
      lastHeartbeatAt: freshestConn.lastHeartbeat?.toISOString() ?? null,
    };
  }

  // Mode-scope gate — same as account-stream.
  const scope = await getUserModeScope(userId, { isAdmin: callerIsAdmin });
  const { includeLive, notLiveReason } = resolveLivePositionVisibility(scope.currentAccountMode);

  if (!includeLive) {
    const partsOff = await fetchInvestorBalanceParts(userId);
    const invOff = composeInvestorBalance({
      userId, accountMode: scope.currentAccountMode,
      allocatedBalance: partsOff.allocatedBalance,
      realizedPnL: partsOff.realizedPnL,
      reservedRisk: partsOff.reservedRisk,
      liveSnapshot: null, now,
    });
    res.json({
      ok: true,
      checkedAt: new Date(now).toISOString(),
      bridgeState,
      account: null,
      positions: [],
      live: toInvestorLiveBalanceWire(invOff),
      reconciliation: null,
      notLiveReason: notLiveReason ?? ACCOUNT_NOT_IN_LIVE_MODE,
      warnings: [],
    });
    return;
  }

  // Fetch open positions for this user — same query as account-stream.
  const posRows = await db.select().from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)));

  // Freshest account-synced connection for equity/balance.
  const equityRows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId))
    .orderBy(sql`${mt5ConnectionTable.accountSyncedAt} DESC NULLS LAST`)
    .limit(1);
  const conn = equityRows[0];
  const acctSynced = conn?.accountSyncedAt ?? null;

  const snapshot = buildLiveAccountSnapshot({
    userId,
    accountMode: "LIVE_SHARED",
    rows: posRows.map((r) => ({
      id: r.id, brokerTicket: r.brokerTicket, symbol: r.symbol, side: r.side,
      volume: r.volume, entryPrice: r.entryPrice, currentPrice: r.currentPrice,
      floatingPl: r.floatingPl, stopLoss: r.stopLoss, takeProfit: r.takeProfit,
      closedAt: r.closedAt, reconcileState: r.reconcileState,
      lastSyncedAtMs: r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null,
    })),
    quotes: undefined,
    account: {
      equity: acctSynced ? (conn?.accountEquity ?? null) : null,
      balance: acctSynced ? (conn?.accountBalance ?? null) : null,
      margin: acctSynced ? (conn?.margin ?? null) : null,
      freeMargin: acctSynced ? (conn?.freeMargin ?? null) : null,
      syncedAtMs: acctSynced ? new Date(acctSynced).getTime() : null,
    },
    lastPositionsSnapshotAtMs: conn?.lastPositionsSnapshotAt
      ? new Date(conn.lastPositionsSnapshotAt).getTime()
      : null,
    now,
  });

  const partsOn = await fetchInvestorBalanceParts(userId);
  const invOn = composeInvestorBalance({
    userId, accountMode: "LIVE_SHARED",
    allocatedBalance: partsOn.allocatedBalance,
    realizedPnL: partsOn.realizedPnL,
    reservedRisk: partsOn.reservedRisk,
    liveSnapshot: snapshot, now,
  });

  // Light reconciliation — DB open count vs bridge-reported open count.
  const dbOpenCount = posRows.length;
  const bridgeOpenCount = conn?.lastPositionsSnapshotAt
    ? (posRows.filter((r) => r.reconcileState !== "BROKER_ABSENT").length)
    : dbOpenCount;
  const ghostsDetected = Math.max(0, dbOpenCount - bridgeOpenCount);

  res.json({
    ok: true,
    checkedAt: new Date(now).toISOString(),
    bridgeState,
    account: {
      balance: acctSynced ? (conn?.accountBalance ?? null) : null,
      equity: acctSynced ? (conn?.accountEquity ?? null) : null,
      margin: acctSynced ? (conn?.margin ?? null) : null,
      freeMargin: acctSynced ? (conn?.freeMargin ?? null) : null,
      // marginLevel is not a stored connection column; the SSE snapshot also
      // never derives it, so keep it null here rather than fabricate.
      marginLevel: snapshot.marginLevel ?? null,
      openPL: snapshot.openPL,
      openPositionsCount: snapshot.openPositionsCount,
      syncedAtMs: acctSynced ? new Date(acctSynced).getTime() : null,
      freshness: snapshot.freshness,
    },
    positions: snapshot.positions,
    live: toInvestorLiveBalanceWire(invOn),
    reconciliation: { ghostsDetected, bridgeOpenCount, dbOpenCount },
    notLiveReason: null,
    warnings: snapshot.warnings,
  });
});

// ── Live account snapshot stream (SSE) — Dashboard / Open Trades real-time ───
//
// Emits the shared LiveAccountSnapshot so Dashboard + Open Trades render one
// agreeing truth. HONESTY: this stream is only as live as the EA/broker update
// cadence. Until the EA pushes quotes/per-tick P/L, the freshest value is the
// last positions-snapshot, and every event carries an explicit `freshness`
// state (live/fresh/delayed/stale/unavailable) so the UI never paints a stale
// value as tick-live. The server re-evaluates on an interval (cheap DB read +
// pure adapter) AND the client should fall back to polling /me/live/positions
// if the stream drops. No execution, no bridge mutation — read-only.
//
// Isolation: requireUser + uid; a user only ever receives their own snapshot,
// built from the same mode-scope visibility gate as /me/live/positions.
//
// NOTE (runtime-verify): the snapshot read below reuses the per-user scoped
// query. Wiring this to emit IMMEDIATELY on snapshot/reconciliation writes
// (rather than only on the poll interval) is a follow-up that needs runtime
// validation against the live bridge — flagged as a TODO, not faked here.
router.get("/me/live/account-stream", requireUser, async (req, res) => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const callerIsAdmin = isAdmin(req);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  let aborted = false;
  const send = (event: unknown) => {
    if (aborted) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const { buildLiveAccountSnapshot } = await import("../lib/live/liveAccountSnapshot.js");

  // Build one snapshot using the SAME mode-scope gate as /me/live/positions so
  // the stream can never disagree with the positions list. Returns the safe
  // empty state (not-in-live-mode) when the gate is closed.
  // Task #430 — project the canonical snapshot's live-balance fields onto the
  // SSE event additively, so the stream agrees number-for-number with
  // /me/account-shell. Reuses the live snapshot already built here (no rebuild).
  // Task #451 — shared projector so the SSE `live` sibling and the
  // /me/live/slot-summary poll response emit the IDENTICAL wire shape.
  const toLiveBlock = toInvestorLiveBalanceWire;

  const buildOnce = async () => {
    try {
      const scope = await getUserModeScope(userId, { isAdmin: callerIsAdmin });
      const { includeLive, notLiveReason } = resolveLivePositionVisibility(scope.currentAccountMode);
      if (!includeLive) {
        const partsOff = await fetchInvestorBalanceParts(userId);
        const invOff = composeInvestorBalance({
          userId, accountMode: scope.currentAccountMode,
          allocatedBalance: partsOff.allocatedBalance,
          realizedPnL: partsOff.realizedPnL,
          reservedRisk: partsOff.reservedRisk,
          liveSnapshot: null, now: Date.now(),
        });
        send({
          type: "account_snapshot",
          snapshot: {
            userId: String(userId), accountMode: "UNKNOWN", source: "computed",
            balance: null, equity: null, margin: null, freeMargin: null, marginLevel: null,
            accountSyncedAtMs: null,
            openPL: null, openPositionsCount: 0, positions: [],
            lastComputedAtMs: Date.now(), freshness: "unavailable",
            warnings: [], notLiveReason: notLiveReason ?? ACCOUNT_NOT_IN_LIVE_MODE,
          },
          live: toLiveBlock(invOff),
          ts: Date.now(),
        });
        return;
      }
      const rows = await db.select().from(arxLivePositionsTable)
        .where(and(eq(arxLivePositionsTable.userId, userId), isNull(arxLivePositionsTable.closedAt)));
      // Deterministically pick the user's most-recently account-synced
      // connection (NULLS LAST) so a multi-connection user never reads a stale
      // row's figures over a freshly-synced one.
      const equityRows = await db.select().from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.userId, userId))
        .orderBy(sql`${mt5ConnectionTable.accountSyncedAt} DESC NULLS LAST`)
        .limit(1);
      const conn = equityRows[0];
      // Honesty: accountBalance/equity/margin/freeMargin default to 0 in the DB,
      // so an existing-but-never-synced connection would emit fabricated zeros.
      // Only surface figures the EA has actually delivered (accountSyncedAt
      // present); otherwise null. Never paint a default 0 as a real broker value.
      const acctSynced = conn?.accountSyncedAt ?? null;
      const snapshot = buildLiveAccountSnapshot({
        userId,
        accountMode: "LIVE_SHARED",
        rows: rows.map((r) => ({
          id: r.id, brokerTicket: r.brokerTicket, symbol: r.symbol, side: r.side,
          volume: r.volume, entryPrice: r.entryPrice, currentPrice: r.currentPrice,
          floatingPl: r.floatingPl, stopLoss: r.stopLoss, takeProfit: r.takeProfit,
          closedAt: r.closedAt, reconcileState: r.reconcileState,
          lastSyncedAtMs: r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : null,
        })),
        // No EA quote push yet → no fresh quotes supplied → P/L falls back to the
        // broker floating P/L from the last snapshot, labelled by its real age.
        quotes: undefined,
        // Real account figures the EA pushed via heartbeat / sync-account.
        // syncedAtMs is the dedicated account-sync marker (not updatedAt) so the
        // client can honestly flag equity as stale when it ages past 60s.
        account: {
          equity: acctSynced ? (conn?.accountEquity ?? null) : null,
          balance: acctSynced ? (conn?.accountBalance ?? null) : null,
          margin: acctSynced ? (conn?.margin ?? null) : null,
          freeMargin: acctSynced ? (conn?.freeMargin ?? null) : null,
          syncedAtMs: acctSynced ? new Date(acctSynced).getTime() : null,
        },
        // Bridge's last complete positions snapshot — used by the adapter to
        // classify broker-confirmed-absent rows for display exclusion. The
        // select-all query already fetches this column; access it directly.
        lastPositionsSnapshotAtMs: conn?.lastPositionsSnapshotAt
          ? new Date(conn.lastPositionsSnapshotAt).getTime()
          : null,
        now: Date.now(),
      });
      const partsOn = await fetchInvestorBalanceParts(userId);
      const invOn = composeInvestorBalance({
        userId, accountMode: "LIVE_SHARED",
        allocatedBalance: partsOn.allocatedBalance,
        realizedPnL: partsOn.realizedPnL,
        reservedRisk: partsOn.reservedRisk,
        liveSnapshot: snapshot, now: Date.now(),
      });
      send({ type: "account_snapshot", snapshot, live: toLiveBlock(invOn), ts: Date.now() });
    } catch {
      // error_safe: never leak internals; tell the client to fall back.
      send({ type: "error_safe", message: "Account stream temporarily unavailable.", ts: Date.now() });
    }
  };

  await buildOnce();

  // Instant push: when an EA write route (heartbeat, account sync, live
  // positions snapshot) signals this user's live state changed, rebuild the
  // snapshot immediately instead of waiting for the 3s fallback tick. Bursts
  // (heartbeat + sync-account + positions land within milliseconds) are
  // coalesced: at most one build runs at a time, and a single trailing rebuild
  // captures anything that arrived mid-build, bounded by a short min-gap so a
  // chatty EA can never hammer the DB read.
  const { liveAccountEventBus } = await import("../lib/live/liveAccountEventBus.js");
  const MIN_PUSH_GAP_MS = 250;
  let building = false;
  let pendingRebuild = false;
  let lastBuildAt = 0;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  const runBuild = async () => {
    if (aborted) return;
    building = true;
    lastBuildAt = Date.now();
    try {
      await buildOnce();
    } finally {
      building = false;
      if (pendingRebuild && !aborted) {
        pendingRebuild = false;
        void runBuild();
      }
    }
  };
  const onLiveChange = () => {
    if (aborted) return;
    if (building) { pendingRebuild = true; return; }
    const sinceLast = Date.now() - lastBuildAt;
    if (sinceLast >= MIN_PUSH_GAP_MS) {
      void runBuild();
    } else if (gapTimer == null) {
      gapTimer = setTimeout(() => { gapTimer = null; if (!aborted) void runBuild(); }, MIN_PUSH_GAP_MS - sinceLast);
    }
  };
  liveAccountEventBus.on(userId, onLiveChange);

  // Re-evaluate on a modest interval. This is a safe fallback cadence; it does
  // NOT imply tick-by-tick liveness — the freshness field tells that truth.
  const tick = setInterval(() => { if (!aborted) void buildOnce(); }, 3_000);
  const heartbeat = setInterval(() => { if (!aborted) send({ type: "heartbeat", ts: Date.now() }); }, 15_000);
  req.on("close", () => {
    aborted = true;
    clearInterval(tick);
    clearInterval(heartbeat);
    if (gapTimer != null) { clearTimeout(gapTimer); gapTimer = null; }
    liveAccountEventBus.off(userId, onLiveChange);
  });
});

export default router;
export { Response };
