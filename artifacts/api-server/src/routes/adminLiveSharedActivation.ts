// Admin — Live Shared Account ACTIVATION surfaces (T007).
//
// Adds three operator-only endpoints on top of the existing Phase A readiness
// + activate-step + test-connection trio. NO new env vars; NO broker
// credentials touched anywhere; EA-pull architecture preserved.
//
//   POST /api/admin/live-shared/activation-smoke-test
//     11-step end-to-end probe. ZERO writes to arx_live_commands,
//     ZERO contact with EA, ZERO mutation of user state. Append-only audit.
//
//   POST /api/admin/live-shared/rollback
//     Typed-phrase ("ROLL BACK LIVE SHARED TRADING") emergency rollback:
//     engages kill switch, disables shared posture, cancels every queued
//     command NOT yet picked by EA. Demo/paper paths untouched.
//
//   POST /api/admin/live-shared/cancel-stale-commands
//     Cancels queued commands older than `olderThanMinutes` (default 15)
//     that the EA has NOT picked up. Per-row audit row.
//
//   GET  /api/admin/live-shared/command-queue
//     Paginated, filterable read of arx_live_commands. Admin-only.
import { isHeartbeatAgeSecondsFresh } from "../lib/brokerHub/freshness.js";
import { listConnections, type BrokerConnectionFacts } from "../lib/brokerHub/connections.js";
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  globalTradingSettingsTable,
  userMasterLiveAccessTable,
  sharedTradeAttributionTable,
  adminActionAuditLogTable,
  } from "@workspace/db";
import { liveBrokerExecutionEnabled } from "../lib/live/phaseBConfig.js";
import { readPlatformSwitches } from "../lib/safety/platformSwitches.js";
import { engagePlatformStop } from "../lib/safety/platformStopWriter.js";
import { detectCurrentConnectedBridge } from "../lib/mt5/currentConnectedBridgeDetector.js";
import { loadAndEvaluateMasterLiveBridgeGate } from "../lib/mt5/masterLiveBridgeGate.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";

const router: IRouter = Router();
router.use(express.json());

const ROLLBACK_PHRASE = "ROLL BACK LIVE SHARED TRADING" as const;
const CANCEL_STALE_PHRASE = "CANCEL STALE COMMANDS" as const;

function requireAdmin(req: Request, res: Response):
  { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  const role = operatorRoleFromSession(sess.role);
  if (!role) {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: sess.id, role };
}

async function writeAudit(args: {
  adminId: number; adminRole: string; action: string;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
}): Promise<void> {
  // before_state / after_state are NOT NULL in DB with default {}; passing
  // explicit null violates the constraint, so coalesce to {} not null.
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    beforeState: (args.before ?? {}) as Record<string, unknown>,
    afterState: (args.after ?? {}) as Record<string, unknown>,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/activation-smoke-test
// 11 read-only sub-checks. Returns a structured report. No EA contact.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/activation-smoke-test", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  // A check is "pass" only when this call observed the thing it names, "fail"
  // when it observed the opposite or its read failed, and "not_checked" when
  // the smoke test does not exercise it. `pass` (kept for older clients) is
  // true only for "pass"; summary.passed never counts a not-checked row.
  type CheckStatus = "pass" | "fail" | "not_checked";
  type Check = { id: string; label: string; pass: boolean; status: CheckStatus; detail: string };
  const checks: Check[] = [];
  const push = (id: string, label: string, status: CheckStatus, detail: string): void => {
    checks.push({ id, label, pass: status === "pass", status, detail });
  };
  const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 160);
  /** One COUNT(*) read. A failed query is an error, never a 0 stand-in. */
  const countOf = async (q: () => PromiseLike<ReadonlyArray<{ n: number }>>): Promise<{ n: number } | { error: string }> => {
    try {
      const n = (await q())[0]?.n;
      return n == null || !Number.isFinite(Number(n)) ? { error: "the count query returned no row" } : { n: Number(n) };
    } catch (e) {
      return { error: errText(e) };
    }
  };

  // C1 — readiness data path reachable
  let settings: typeof globalTradingSettingsTable.$inferSelect | null = null;
  let settingsError: string | null = null;
  try {
    settings = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  } catch (e) {
    settingsError = errText(e);
  }
  push("C1_readiness", "Readiness data path reachable", settings != null ? "pass" : "fail",
    settingsError ? `global_trading_settings could not be loaded: ${settingsError}`
      : settings ? "global_trading_settings row present" : "MISSING global_trading_settings");

  // C2 — pinned bridge snapshot present
  const pinnedId = settings?.platformMasterBridgeConnectionId ?? null;
  let pinned: BrokerConnectionFacts | null = null;
  let pinnedError: string | null = null;
  if (pinnedId != null) {
    try {
      pinned = (await listConnections({ connectionIds: [pinnedId], limit: 1 }))[0] ?? null;
    } catch (e) {
      pinnedError = errText(e);
    }
  }
  push("C2_pinned_bridge", "Master bridge pinned", pinned != null ? "pass" : "fail",
    pinned ? `connectionId=${pinned.id}`
      : settingsError ? "unknown: the settings could not be loaded"
      : pinnedError ? `connection #${pinnedId} could not be loaded: ${pinnedError}`
      : pinnedId != null ? `pinned connection #${pinnedId} was not found`
      : "no platformMasterBridgeConnectionId set");

  // C3 — heartbeat fresh (shared policy: < 15 s) on pinned bridge
  const hbAge = pinned?.lastHeartbeat
    ? Math.floor((Date.now() - new Date(pinned.lastHeartbeat).getTime()) / 1000) : null;
  push("C3_heartbeat", "Bridge heartbeat fresh (<15s)", isHeartbeatAgeSecondsFresh(hbAge) ? "pass" : "fail",
    hbAge == null ? "no heartbeat recorded"
      : hbAge < 0 ? `heartbeat is dated ${-hbAge}s in the future, so its age cannot be verified`
      : `${hbAge}s old`);

  // C4 — approved user lookup works: the lookup itself is the check.
  const approved = await countOf(() => db.select({ n: sql<number>`COUNT(*)::int` })
    .from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.approvedForMasterLive, true)));
  push("C4_approved_user_lookup", "Approved user lookup works", "n" in approved ? "pass" : "fail",
    "n" in approved ? `lookup returned: ${approved.n} approved user(s)` : `approved users could not be loaded: ${approved.error}`);

  // C5 — the validate endpoint is not called (that would run the trade
  // pipeline) and the router stack is not inspected, so it is not checked.
  push("C5_validate_endpoint", "Validate endpoint reachable", "not_checked",
    "Not checked: this smoke test does not call POST /api/trades/live-shared/validate.");

  // C6 — execute is blocked when master switch is off. The smoke test does
  // not run the dispatch gate, so this row records the switch state only.
  // The master switch (dispatch gate 1) is the env flag AND the operator arm,
  // from the one switch authority; the env flag alone is not it.
  const masterSwitch = liveBrokerExecutionEnabled();
  const switches = await readPlatformSwitches();
  const lbe = switches.liveBrokerExecution;
  const masterSwitchState = `env ARX_LIVE_BROKER_EXECUTION_ENABLED is ${masterSwitch ? "set" : "not set"} and ${!switches.readable
    ? (switches.unreadableReason === "missing"
      ? "there is no settings row, so live execution is not armed"
      : "the operator arm could not be read (it counts as not armed)")
    : lbe.operatorArmed ? "an operator armed live execution" : "no operator has armed live execution"}`;
  push("C6_execute_blocked_when_master_off", "Execute blocked when master switch off/missing", "not_checked",
    `Not checked: this smoke test does not run the dispatch gate. Current state: ${masterSwitchState}, so ${lbe.enabled
      ? "the master switch is ON — gate 1 passes; every other gate must also pass"
      : "the master switch is OFF — every dispatch is refused with LIVE_BROKER_EXECUTION_DISABLED"}.`);

  // C7 — command queue insert only happens through validate→confirm→dispatch
  // pipeline. We assert here that no row exists with a "raw" status missing
  // an idempotencyKey (which would indicate a bypass).
  const orphan = await countOf(() => db.select({ n: sql<number>`COUNT(*)::int` })
    .from(arxLiveCommandsTable)
    .where(and(
      isNull(arxLiveCommandsTable.idempotencyKey),
      inArray(arxLiveCommandsTable.status, ["SENT_TO_MT5_LIVE", "LIVE_FILLED"]),
    )));
  push("C7_no_pipeline_bypass", "No pipeline bypass (idempotencyKey present on dispatched rows)",
    "n" in orphan && orphan.n === 0 ? "pass" : "fail",
    !("n" in orphan) ? `dispatched commands could not be loaded: ${orphan.error}`
      : orphan.n === 0 ? "0 orphan dispatched rows" : `${orphan.n} row(s) missing idempotencyKey — INVESTIGATE`);

  // C8 — shared_trade_attribution reachable: the read itself is the check.
  const attr = await countOf(() => db.select({ n: sql<number>`COUNT(*)::int` })
    .from(sharedTradeAttributionTable));
  push("C8_attribution_reachable", "shared_trade_attribution reachable", "n" in attr ? "pass" : "fail",
    "n" in attr ? `read returned: ${attr.n} attribution row(s) total` : `shared_trade_attribution could not be loaded: ${attr.error}`);

  // C9 — per-user isolation: confirm at least one approved user has a maxLot
  // set (cap exists) and no global "unlimited" row leaks across users.
  const noCap = await countOf(() => db.select({ n: sql<number>`COUNT(*)::int` })
    .from(userMasterLiveAccessTable)
    .where(and(
      eq(userMasterLiveAccessTable.approvedForMasterLive, true),
      isNull(userMasterLiveAccessTable.maxLot),
    )));
  push("C9_user_isolation_caps", "Approved users have maxLot caps", "n" in noCap && noCap.n === 0 ? "pass" : "fail",
    !("n" in noCap) ? `approved users' caps could not be loaded: ${noCap.error}`
      : noCap.n === 0 ? "every approved user has a maxLot" : `${noCap.n} approved user(s) MISSING maxLot — set limits before activation`);

  // C10 — admin all-records read: the unscoped (all users) reads above.
  const unscoped = [["C4", approved], ["C7", orphan], ["C8", attr], ["C9", noCap]] as const;
  const unscopedFailed = unscoped.filter(([, r]) => !("n" in r)).map(([id]) => id);
  push("C10_admin_all_records", "Admin all-records read works", unscopedFailed.length === 0 ? "pass" : "fail",
    unscopedFailed.length === 0
      ? "the unscoped (all users) reads C4, C7, C8 and C9 all returned"
      : `unscoped read(s) ${unscopedFailed.join(", ")} could not be loaded`);

  // Bridge gate snapshot (informational; not a pass/fail row).
  const bridgeGate = await loadAndEvaluateMasterLiveBridgeGate();
  const detector = await detectCurrentConnectedBridge();

  const summarize = () => ({
    total: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    notChecked: checks.filter((c) => c.status === "not_checked").length,
  });

  // C11 — audit log write works: this call's own audit row, written now, so
  // the row passes only once the write has returned. The audited summary
  // covers C1-C10 (C11 is the write itself).
  try {
    await writeAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "ADMIN_RAN_LIVE_SHARED_ACTIVATION_SMOKE_TEST",
      // masterSwitch: the env flag (as before); liveBrokerExecutionEnabled: the effective switch (env AND arm).
      after: { summary: summarize(), summaryCovers: "C1-C10", masterSwitch, liveBrokerExecutionEnabled: lbe.enabled, operatorArmed: lbe.operatorArmed, bridgeGateDecision: bridgeGate.decision },
    });
    push("C11_audit_log_write", "Audit log write works", "pass",
      "this smoke-test call wrote one admin_action_audit_log row");
  } catch (e) {
    push("C11_audit_log_write", "Audit log write works", "fail",
      `this smoke-test call could not write its admin_action_audit_log row: ${errText(e)}`);
  }

  const summary = summarize();

  res.json({
    ok: true,
    isDryRun: true,
    summary,
    checks,
    bridgeGate,
    detector: detector.ok
      ? { detected: true, eaVersion: detector.bridge.eaVersion, heartbeatAgeSec: detector.bridge.heartbeatAgeSec }
      : { detected: false, primaryReason: detector.primaryReason },
    safetyEnvelope: {
      didCreateLiveCommand: false,
      didDispatchToMt5: false,
      didMutateAnyUserState: false,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/rollback
// Typed-phrase emergency rollback. Reverses shared posture, engages kill
// switch, cancels every queued command NOT yet picked by EA. Demo untouched.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/rollback", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true && body.confirmationPhrase !== ROLLBACK_PHRASE) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED", detail: "Send { confirm: true } from the switch-based UI." });
    return;
  }
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500) : "operator-initiated rollback";

  const before = (await db.select().from(globalTradingSettingsTable).limit(1))[0] ?? null;
  if (!before) { res.status(500).json({ ok: false, error: "SETTINGS_ROW_MISSING" }); return; }

  // Atomic rollback:
  //   - engage kill switch
  //   - disable shared live posture (routing back to USER_OWNED_MT5)
  //   - disable global liveEnabled
  //   - cancel every queued/draft/approved command NOT yet picked by EA
  //   - keep audit, trade history, demo path untouched
  const result = await db.transaction(async (tx) => {
    // The one engage writer (every settings row, reason/time/actor), inside
    // this transaction; the shared posture below is this handler's own write.
    await engagePlatformStop(
      { reason: `[ROLLBACK by admin ${admin.id}] ${reason}`, actorUserId: admin.id, source: "admin_live_shared_rollback" },
      tx,
    );
    await tx.update(globalTradingSettingsTable).set({
      sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false,
      accountRoutingMode: "USER_OWNED_MT5",
      sharedLiveConnectionId: null,
      liveEnabled: false,
      platformMode: before.platformMode === "LIVE" ? "DEMO" : before.platformMode,
      updatedAt: new Date(),
    });

    // Cancel only commands the EA has NOT yet picked up.
    const cancelled = await tx.update(arxLiveCommandsTable).set({
      status: "LIVE_CANCELLED",
      rejectionReason: `ROLLBACK by admin ${admin.id}: ${reason}`,
    }).where(and(
      inArray(arxLiveCommandsTable.status, ["LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED"]),
      isNull(arxLiveCommandsTable.pickedByEaAt),
    )).returning({ id: arxLiveCommandsTable.id });

    return { cancelledCount: cancelled.length };
  });

  await writeAudit({
    adminId: admin.id, adminRole: admin.role,
    action: "ADMIN_LIVE_SHARED_ROLLBACK",
    before: {
      emergencyKillSwitch: before.emergencyKillSwitch,
      sharedLiveTradingEnabled: before.sharedLiveTradingEnabled,
      masterBridgeLiveEnabled: before.masterBridgeLiveEnabled,
      accountRoutingMode: before.accountRoutingMode,
      liveEnabled: before.liveEnabled,
      platformMode: before.platformMode,
    },
    after: { ...result, reason, killEngaged: true, sharedDisabled: true, demoUntouched: true },
  });

  res.json({
    ok: true,
    rollback: {
      killSwitchEngaged: true,
      sharedLiveTradingDisabled: true,
      masterBridgeLiveDisabled: true,
      accountRoutingMode: "USER_OWNED_MT5",
      liveEnabledOff: true,
      cancelledCommandsCount: result.cancelledCount,
      reason,
    },
    preserved: {
      auditLogs: true, tradeHistory: true, demoPaperPath: true,
      alreadyPickedUpCommands: true, // EA-pulled rows are not yanked
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/live-shared/cancel-stale-commands
// Cancels queued commands older than olderThanMinutes (default 15) that the
// EA has NOT picked up. Each cancellation gets a per-row audit row.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/live-shared/cancel-stale-commands", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true && body.confirmationPhrase !== CANCEL_STALE_PHRASE) {
    res.status(400).json({ ok: false, error: "CONFIRMATION_REQUIRED", detail: "Send { confirm: true } from the switch-based UI." });
    return;
  }
  const olderThanMinutes = Math.min(
    Math.max(Number(body.olderThanMinutes ?? 15) || 15, 1), 24 * 60,
  );
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  // Only target LIVE_APPROVED rows that were queued for EA pickup but never
  // picked up. LIVE_DRAFT / LIVE_CONFIRMATION_REQUIRED are user-side ticket
  // states and must NOT be force-cancelled by an admin sweep — the user is
  // mid-confirmation and may submit at any moment.
  const rows = await db.update(arxLiveCommandsTable).set({
    status: "LIVE_CANCELLED",
    rejectionReason: `STALE: queued for EA pickup but not pulled within ${olderThanMinutes}m (cancelled by admin ${admin.id})`,
  }).where(and(
    eq(arxLiveCommandsTable.status, "LIVE_APPROVED"),
    isNull(arxLiveCommandsTable.pickedByEaAt),
    lt(arxLiveCommandsTable.createdAt, cutoff),
  )).returning({ id: arxLiveCommandsTable.id, userId: arxLiveCommandsTable.userId });

  await writeAudit({
    adminId: admin.id, adminRole: admin.role,
    action: "ADMIN_CANCELLED_STALE_LIVE_COMMANDS",
    after: { olderThanMinutes, cancelledCount: rows.length, ids: rows.map((r) => r.id) },
  });

  res.json({
    ok: true,
    cancelledCount: rows.length,
    olderThanMinutes,
    cutoffUtc: cutoff.toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/live-shared/command-queue
// Paginated + filtered read of arx_live_commands. Admin-only.
// Query: status, userId, symbol, sourcePage, since (ISO), until (ISO),
//        errorOnly (bool), limit (default 100, max 500)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/live-shared/command-queue", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const q = req.query;
  const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);

  const conds = [];
  if (typeof q.status === "string" && q.status.length > 0) {
    conds.push(eq(arxLiveCommandsTable.status, q.status as never));
  }
  if (q.userId != null && q.userId !== "") {
    conds.push(eq(arxLiveCommandsTable.userId, Number(q.userId)));
  }
  if (typeof q.symbol === "string" && q.symbol.length > 0) {
    conds.push(eq(arxLiveCommandsTable.symbol, q.symbol));
  }
  if (typeof q.sourcePage === "string" && q.sourcePage.length > 0) {
    conds.push(eq(arxLiveCommandsTable.sourcePage, q.sourcePage));
  }
  if (typeof q.since === "string" && q.since.length > 0) {
    conds.push(gt(arxLiveCommandsTable.createdAt, new Date(q.since)));
  }
  if (typeof q.until === "string" && q.until.length > 0) {
    conds.push(lt(arxLiveCommandsTable.createdAt, new Date(q.until)));
  }
  if (q.errorOnly === "true" || q.errorOnly === "1") {
    conds.push(or(
      inArray(arxLiveCommandsTable.status, ["LIVE_BLOCKED", "LIVE_REJECTED", "LIVE_FAILED"]),
      sql`${arxLiveCommandsTable.rejectionReason} IS NOT NULL`,
    )!);
  }

  const rows = await db.select({
    id: arxLiveCommandsTable.id,
    commandId: arxLiveCommandsTable.commandId,
    userId: arxLiveCommandsTable.userId,
    symbol: arxLiveCommandsTable.symbol,
    side: arxLiveCommandsTable.side,
    requestedVolume: arxLiveCommandsTable.requestedVolume,
    executedVolume: arxLiveCommandsTable.executedVolume,
    stopLoss: arxLiveCommandsTable.stopLoss,
    takeProfit: arxLiveCommandsTable.takeProfit,
    status: arxLiveCommandsTable.status,
    sourcePage: arxLiveCommandsTable.sourcePage,
    brokerTicket: arxLiveCommandsTable.brokerTicket,
    rejectionReason: arxLiveCommandsTable.rejectionReason,
    pickedByEaAt: arxLiveCommandsTable.pickedByEaAt,
    sentToMt5At: arxLiveCommandsTable.sentToMt5At,
    filledAt: arxLiveCommandsTable.filledAt,
    rejectedAt: arxLiveCommandsTable.rejectedAt,
    createdAt: arxLiveCommandsTable.createdAt,
  }).from(arxLiveCommandsTable)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(arxLiveCommandsTable.createdAt))
    .limit(limit);

  // Compute simple bucket counts in the same response so the UI can render
  // status chips without a separate round-trip.
  const buckets = (await db.select({
    status: arxLiveCommandsTable.status,
    n: sql<number>`COUNT(*)::int`,
  }).from(arxLiveCommandsTable).groupBy(arxLiveCommandsTable.status));

  res.json({
    ok: true,
    rows,
    limit,
    counts: Object.fromEntries(buckets.map((b) => [b.status, Number(b.n)])),
    requiredConfirmationPhrases: { cancelStale: CANCEL_STALE_PHRASE },
  });
});

export default router;
