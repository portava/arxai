// Live Test Cycle service — OWNER-only single-shot live verification.
//
// SAFETY:
// - Builds nothing of its own around the gate evaluator. Every live
//   command (open and auto-close) is created through the existing
//   `createLiveDraft` / `createLiveOpsDraft` → `confirmLiveCommand` →
//   `dispatchLiveCommand` path, so the 16-gate evaluator, allocation
//   freeze gate, operator-funded pilot gate, master-live bridge gate,
//   per-user isolation, idempotency belt and audit row all run as
//   normal. We never bypass.
// - Single-flight is enforced at the DB layer by a partial unique index
//   on (user_id) WHERE status is non-terminal. A second `start` for the
//   same OWNER while a cycle is open returns LIVE_TEST_CYCLE_IN_PROGRESS.
// - Auto-close fires exactly once when the OPEN command transitions to
//   LIVE_FILLED. If the CLOSE dispatch is BLOCKED (or its command later
//   rejects), the cycle locks in CLOSE_FAILED_MANUAL_REQUIRED — we never
//   retry. An operator must use /resolve to acknowledge.

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  arxLiveTestCyclesTable,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
  liveTradingAuditTable,
  userMasterLiveAccessTable,
  ARX_LIVE_TEST_CYCLE_TERMINAL,
  type ArxLiveTestCycle,
  type ArxLiveTestCycleStatus,
} from "@workspace/db";
import {
  createLiveDraft,
  createLiveOpsDraft,
  confirmLiveCommand,
  dispatchLiveCommand,
  cancelLiveCommand,
} from "./liveCommandPipeline.js";
import { getMyArming } from "./liveArming.js";
import { computeRealizedPnlUsd } from "./realizedPnl.js";
import { resolveLiveCloseConfirmation, hasCloseErrorReason } from "./closeConfirmation.js";
import { liveBrokerExecutionEnabled, resolveLiveBrokerExecutionEnabledAsync } from "./phaseBConfig.js";
import { logger } from "../logger.js";

const PINNED_SYMBOL = "EURUSD" as const;
const PINNED_VOLUME = 0.01 as const;
const HEARTBEAT_FRESH_MS = 15_000;

export interface LiveTestCycleInput {
  userId: number;
  side: "BUY" | "SELL";
  stopLoss: number;
  takeProfit?: number | null;
}

export interface PrecheckRow {
  key: string;
  ok: boolean;
  detail: string;
}

async function audit(args: {
  eventType: string; userId: number; message: string;
  severity?: string; metadata?: Record<string, unknown>;
}) {
  await db.insert(liveTradingAuditTable).values({
    eventId: randomUUID(),
    eventType: args.eventType,
    severity: args.severity ?? "INFO",
    mode: "READ_ONLY",
    symbol: PINNED_SYMBOL,
    message: args.message,
    actorRole: "owner",
    metadata: { userId: args.userId, ...(args.metadata ?? {}) },
  });
}

async function loadBridgeFacts(userId: number) {
  const rows = await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId));
  const fresh = rows
    .filter((b) => !b.tokenRevokedAt)
    .sort((a, b) => {
      const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
      return bh - ah;
    })[0] ?? null;
  return fresh;
}

export async function runPrecheck(userId: number): Promise<{
  ok: boolean;
  checks: PrecheckRow[];
  masterSwitchEnabled: boolean;
  cycleInProgress: ArxLiveTestCycle | null;
}> {
  const checks: PrecheckRow[] = [];

  // 0. existing cycle?
  const existingRows = await db.select().from(arxLiveTestCyclesTable)
    .where(and(
      eq(arxLiveTestCyclesTable.userId, userId),
      sql`status not in ('DRY_RUN_BLOCKED','OPEN_REJECTED','CLOSE_FAILED_MANUAL_REQUIRED','COMPLETED')`,
    )).limit(1);
  const cycleInProgress = existingRows[0] ?? null;
  checks.push({
    key: "no_cycle_in_progress",
    ok: !cycleInProgress,
    detail: cycleInProgress
      ? `cycle ${cycleInProgress.cycleId} is at status ${cycleInProgress.status}; resolve it before starting another`
      : "no existing cycle in progress",
  });

  // 1. master switch
  const masterAsync = await resolveLiveBrokerExecutionEnabledAsync().catch(() => false);
  const masterOk = liveBrokerExecutionEnabled() || masterAsync === true;
  checks.push({
    key: "master_switch_on",
    ok: masterOk,
    detail: masterOk
      ? "ARX_LIVE_BROKER_EXECUTION_ENABLED resolves to true"
      : "ARX_LIVE_BROKER_EXECUTION_ENABLED is OFF — flip server env + operator switch to true",
  });

  // 2. armed + 3. kill switch
  const arming = await getMyArming(userId);
  checks.push({
    key: "user_armed_for_live",
    ok: !!arming?.isArmed,
    detail: arming?.isArmed
      ? `armed at ${arming.armedAt?.toISOString?.() ?? "?"}`
      : "user is not armed for live — arm on MT5 Setup",
  });
  checks.push({
    key: "kill_switch_released",
    ok: !arming?.killSwitchEngaged,
    detail: arming?.killSwitchEngaged
      ? `kill switch engaged: ${arming.killSwitchReason ?? "(no reason)"}`
      : "kill switch released",
  });

  // 4. bridge heartbeat fresh
  const bridge = await loadBridgeFacts(userId);
  const heartbeatAgeMs = bridge?.lastHeartbeat
    ? Date.now() - new Date(bridge.lastHeartbeat).getTime()
    : null;
  const heartbeatOk = heartbeatAgeMs != null && heartbeatAgeMs <= HEARTBEAT_FRESH_MS;
  checks.push({
    key: "bridge_heartbeat_fresh",
    ok: heartbeatOk,
    detail: bridge
      ? heartbeatAgeMs != null
        ? `last heartbeat ${(heartbeatAgeMs / 1000).toFixed(1)}s ago (must be ≤ ${HEARTBEAT_FRESH_MS / 1000}s)`
        : "no heartbeat received yet"
      : "no MT5 bridge configured",
  });

  // 4b. Task #30 — EA host clock drift. A SEVERE drift means ARX cannot trust
  // the EA's timestamps (heartbeat age, command TTL). Additive refusal: this
  // only ever ADDS a block; it never relaxes any other check.
  const driftSeverity = (bridge?.clockDriftSeverity ?? "OK").toUpperCase();
  const driftOk = driftSeverity !== "SEVERE";
  checks.push({
    key: "ea_clock_drift_ok",
    ok: driftOk,
    detail: driftOk
      ? `EA host clock drift ${driftSeverity.toLowerCase()}${bridge?.clockDriftSeconds != null ? ` (${bridge.clockDriftSeconds.toFixed(1)}s)` : ""}`
      : `EA host clock is severely out of sync (${bridge?.clockDriftSeconds?.toFixed(1) ?? "?"}s) — fix the VPS/host clock before live testing`,
  });

  // 5. EA inputs: account type live, EnableLiveExecution=true, ReadOnlyMode=false
  const acctType = (bridge?.accountType ?? "").toLowerCase();
  const acctOk = acctType === "live" || acctType === "real";
  checks.push({
    key: "ea_account_type_live",
    ok: acctOk,
    detail: acctOk ? `accountType=${acctType}` : `accountType=${bridge?.accountType ?? "?"} (must be live/real)`,
  });
  // EA inputs live in mt5_connection.capabilities.eaInputs as reported by
  // the EA heartbeat. The legacy `bridge.eaState` lookup never existed on
  // the row, which silently defaulted every flag to false (3 spurious
  // FAILs). Always read from capabilities.eaInputs.
  const caps = (bridge as unknown as { capabilities?: { eaInputs?: Record<string, unknown> } } | null)?.capabilities ?? null;
  const eaInputs = (caps?.eaInputs ?? {}) as Record<string, unknown>;
  const enableLive = eaInputs["enableLiveExecution"] === true;
  // ReadOnlyMode default-safe: if the EA hasn't reported it, treat as ON
  // (locked) rather than OFF — never assume permissive without evidence.
  const readOnly = eaInputs["readOnlyMode"] !== false;
  const algoAllowed = eaInputs["algoTradingAllowed"] === true;
  const terminalConnected = eaInputs["terminalConnected"] === true;
  checks.push({
    key: "ea_enable_live_execution",
    ok: enableLive,
    detail: enableLive ? "EnableLiveExecution=true" : "EA input EnableLiveExecution is false — set to true in MT5",
  });
  checks.push({
    key: "ea_read_only_off",
    ok: !readOnly,
    detail: readOnly ? "EA input ReadOnlyMode=true — flip to false in MT5" : "ReadOnlyMode=false",
  });
  checks.push({
    key: "ea_algo_trading_allowed",
    ok: algoAllowed,
    detail: algoAllowed ? "AlgoTrading allowed" : "MT5 AlgoTrading button is off — toggle it on",
  });
  checks.push({
    key: "ea_terminal_connected",
    ok: terminalConnected,
    detail: terminalConnected ? "terminal connected" : "MT5 terminal reports disconnected from broker",
  });

  // 6. user master live access approved (for Live Shared bridge usage)
  const accessRows = await db.select({
    approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
    assignedRiskTemplateId: userMasterLiveAccessTable.assignedRiskTemplateId,
  }).from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, userId)).limit(1);
  const access = accessRows[0];
  checks.push({
    key: "approved_for_master_live",
    ok: !!access?.approvedForMasterLive,
    detail: access?.approvedForMasterLive
      ? "approved for Live Shared / master bridge"
      : "user not approved for Live Shared bridge — operator must approve",
  });

  // 7. no existing open arx_live_positions for EURUSD
  const openPos = await db.select({ id: arxLivePositionsTable.id }).from(arxLivePositionsTable)
    .where(and(
      eq(arxLivePositionsTable.userId, userId),
      eq(arxLivePositionsTable.symbol, PINNED_SYMBOL),
      isNull(arxLivePositionsTable.closedAt),
    )).limit(1);
  checks.push({
    key: "no_existing_eurusd_position",
    ok: openPos.length === 0,
    detail: openPos.length === 0
      ? "no open EURUSD position"
      : "an EURUSD position is already open — close it before the cycle",
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks, masterSwitchEnabled: masterOk, cycleInProgress };
}

/**
 * Dry-run preview. Runs precheck + the same preflight that createLiveDraft
 * runs (by creating a draft and immediately cancelling it on success).
 * Does NOT dispatch and does NOT contact the EA. Returns the precheck list
 * and a preflightResult { ok, reason, detail } summarising what
 * createLiveDraft itself would say.
 */
export async function previewCycle(input: LiveTestCycleInput) {
  const precheck = await runPrecheck(input.userId);

  // Run preflight by attempting createLiveDraft, then immediately cancel
  // it on success. The draft only inserts a LIVE_CONFIRMATION_REQUIRED
  // row — it does not contact the EA. Cancelling moves it to
  // LIVE_CANCELLED (allowed transition). Net effect on the live
  // pipeline: one short-lived audit-only row.
  type DraftRefusal = { ok: false; reason: string; detail?: string };
  type DraftOk = { ok: true; command: { commandId: string } };
  let preflight: DraftRefusal | DraftOk = { ok: false, reason: "PRECHECK_BLOCKED", detail: "skipped — precheck failed" };
  let cancelledDraftId: string | null = null;

  if (precheck.ok) {
    const d = await createLiveDraft({
      userId: input.userId,
      commandType: "PLACE_LIVE_MARKET_ORDER",
      symbol: PINNED_SYMBOL,
      side: input.side,
      orderType: input.side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
      requestedVolume: PINNED_VOLUME,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit ?? null,
      sourcePage: "LIVE_TEST_CYCLE_PREVIEW",
      rubyExplanationSummary: "Live Test Cycle dry-run preview",
      payload: { livetestCycleDryRun: true },
    });
    if (d.ok) {
      cancelledDraftId = d.command.commandId;
      await cancelLiveCommand({
        userId: input.userId,
        commandId: d.command.commandId,
        reason: "live_test_cycle_dry_run",
      }).catch(() => undefined);
      preflight = { ok: true, command: { commandId: d.command.commandId } };
    } else {
      preflight = { ok: false, reason: d.reason, detail: d.detail };
    }
  }

  await audit({
    eventType: "LIVE_TEST_CYCLE_PREVIEW",
    userId: input.userId,
    message: `Preview: precheck=${precheck.ok ? "PASS" : "BLOCKED"} preflight=${preflight.ok ? "PASS" : `BLOCKED:${preflight.reason}`}`,
    metadata: {
      precheckChecks: precheck.checks,
      preflight: preflight.ok ? { ok: true } : preflight,
      cancelledDraftId,
    },
  });

  return {
    ok: precheck.ok && preflight.ok,
    masterSwitchEnabled: precheck.masterSwitchEnabled,
    precheck: precheck.checks,
    preflight,
    cycleInProgress: precheck.cycleInProgress,
    cancelledDraftId,
    note: "Preview ran preflight + visible safety checks. The full 16-gate evaluator only runs at /start with TOCTOU re-checks.",
  };
}

/**
 * Start a live test cycle. Validates precheck, refuses if a non-terminal
 * cycle already exists for this user. Otherwise inserts the cycle row,
 * dispatches the OPEN command through the standard pipeline, and stores
 * the open commandId. The state then advances lazily via advanceCycle().
 */
export async function startCycle(input: LiveTestCycleInput): Promise<{
  ok: boolean;
  cycle?: ArxLiveTestCycle;
  reason?: string;
  detail?: string;
  precheck?: PrecheckRow[];
  dispatch?: unknown;
}> {
  const precheck = await runPrecheck(input.userId);
  if (precheck.cycleInProgress) {
    return { ok: false, reason: "LIVE_TEST_CYCLE_IN_PROGRESS",
      detail: `cycle ${precheck.cycleInProgress.cycleId} status=${precheck.cycleInProgress.status}`,
      precheck: precheck.checks };
  }
  if (!precheck.ok) {
    return { ok: false, reason: "PRECHECK_BLOCKED",
      detail: precheck.checks.filter((c) => !c.ok).map((c) => c.key).join(","),
      precheck: precheck.checks };
  }

  const cycleId = `lvtc_${randomUUID()}`;
  const preflightStartedAt = new Date();

  // Single-flight: attempt insert; the partial unique index will refuse
  // a duplicate non-terminal row if a race slips past the precheck.
  let row: ArxLiveTestCycle;
  try {
    const inserted = await db.insert(arxLiveTestCyclesTable).values({
      cycleId,
      userId: input.userId,
      status: "PENDING_PRECHECK",
      symbol: PINNED_SYMBOL,
      side: input.side,
      requestedVolume: PINNED_VOLUME,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit ?? null,
      preflightStartedAt,
    }).returning();
    row = inserted[0]!;
  } catch (e) {
    return { ok: false, reason: "LIVE_TEST_CYCLE_IN_PROGRESS",
      detail: `single-flight insert refused: ${e instanceof Error ? e.message : String(e)}` };
  }

  await audit({
    eventType: "LIVE_TEST_CYCLE_STARTED",
    userId: input.userId,
    message: `Live test cycle ${cycleId} started: ${input.side} ${PINNED_SYMBOL} ${PINNED_VOLUME} SL=${input.stopLoss}`,
    metadata: { cycleId, side: input.side, stopLoss: input.stopLoss, takeProfit: input.takeProfit ?? null },
  });

  // OPEN leg — standard pipeline (preflight + draft + confirm + dispatch).
  const draft = await createLiveDraft({
    userId: input.userId,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    symbol: PINNED_SYMBOL,
    side: input.side,
    orderType: input.side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
    requestedVolume: PINNED_VOLUME,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit ?? null,
    sourcePage: "LIVE_TEST_CYCLE",
    rubyExplanationSummary: `Live Test Cycle ${cycleId} (auto-close after open fill)`,
    payload: { liveTestCycleId: cycleId },
  });
  if (!draft.ok) {
    const [updated] = await db.update(arxLiveTestCyclesTable).set({
      status: "OPEN_REJECTED",
      blockGate: "PREFLIGHT",
      blockReason: `${draft.reason}${draft.detail ? `: ${draft.detail}` : ""}`,
      updatedAt: new Date(),
    }).where(eq(arxLiveTestCyclesTable.cycleId, cycleId)).returning();
    await audit({
      eventType: "LIVE_TEST_CYCLE_OPEN_REJECTED", severity: "WARNING",
      userId: input.userId,
      message: `Live test cycle ${cycleId} OPEN draft refused at preflight: ${draft.reason}`,
      metadata: { reason: draft.reason, detail: draft.detail },
    });
    return { ok: false, cycle: updated!, reason: draft.reason, detail: draft.detail };
  }
  const openCommandId = draft.command.commandId;
  const conf = await confirmLiveCommand({ userId: input.userId, commandId: openCommandId });
  if (!conf.ok) {
    const [updated] = await db.update(arxLiveTestCyclesTable).set({
      status: "OPEN_REJECTED",
      openCommandId,
      blockGate: "CONFIRM",
      blockReason: conf.reason,
      updatedAt: new Date(),
    }).where(eq(arxLiveTestCyclesTable.cycleId, cycleId)).returning();
    return { ok: false, cycle: updated!, reason: conf.reason };
  }
  const disp = await dispatchLiveCommand({ userId: input.userId, commandId: openCommandId });
  const dispOk = (disp as { ok?: boolean }).ok === true;
  if (!dispOk) {
    const primary = (disp as { primaryReason?: string }).primaryReason ?? "DISPATCH_BLOCKED";
    const blockReasons = (disp as { blockReasons?: string[] }).blockReasons ?? [primary];
    const [updated] = await db.update(arxLiveTestCyclesTable).set({
      status: "OPEN_REJECTED",
      openCommandId,
      blockGate: primary,
      blockReason: blockReasons.join(","),
      dispatchGateSnapshot: { decision: "BLOCKED", primaryReason: primary, blockReasons } as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(eq(arxLiveTestCyclesTable.cycleId, cycleId)).returning();
    await audit({
      eventType: "LIVE_TEST_CYCLE_OPEN_BLOCKED", severity: "WARNING",
      userId: input.userId,
      message: `Live test cycle ${cycleId} OPEN dispatch BLOCKED: ${primary}`,
      metadata: { primaryReason: primary, blockReasons },
    });
    return { ok: false, cycle: updated!, reason: "LIVE_BLOCKED", detail: primary, dispatch: disp };
  }

  // Dispatch PASS. Look up the live command row to capture sentToMt5At.
  const [openCmd] = await db.select().from(arxLiveCommandsTable)
    .where(eq(arxLiveCommandsTable.commandId, openCommandId)).limit(1);
  const [updated] = await db.update(arxLiveTestCyclesTable).set({
    status: "OPEN_DISPATCHED",
    openCommandId,
    openQueuedAt: openCmd?.sentToMt5At ?? new Date(),
    dispatchGateSnapshot: { decision: "PASS" } as Record<string, unknown>,
    updatedAt: new Date(),
  }).where(eq(arxLiveTestCyclesTable.cycleId, cycleId)).returning();

  return { ok: true, cycle: updated!, dispatch: disp };
}

/**
 * Lazy state-machine advancement. Reads the current cycle, looks up
 * the underlying live commands + positions, and performs at-most-one
 * transition per call (then recurses). Safe to call repeatedly from a
 * UI poll.
 */
export async function advanceCycle(args: { userId: number; cycleId: string }): Promise<ArxLiveTestCycle | null> {
  const [row] = await db.select().from(arxLiveTestCyclesTable).where(and(
    eq(arxLiveTestCyclesTable.cycleId, args.cycleId),
    eq(arxLiveTestCyclesTable.userId, args.userId),
  )).limit(1);
  if (!row) return null;
  if (ARX_LIVE_TEST_CYCLE_TERMINAL.includes(row.status as ArxLiveTestCycleStatus)) return row;

  const now = new Date();
  let changed = false;
  const update: Partial<typeof arxLiveTestCyclesTable.$inferInsert> = { updatedAt: now };

  // OPEN_DISPATCHED → OPEN_FILLED / OPEN_REJECTED
  if (row.status === "OPEN_DISPATCHED" && row.openCommandId) {
    const [open] = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, row.openCommandId)).limit(1);
    if (open) {
      if (!row.eaPickedOpenAt && open.pickedByEaAt) { update.eaPickedOpenAt = open.pickedByEaAt; changed = true; }
      if (open.status === "LIVE_FILLED") {
        update.status = "OPEN_FILLED";
        update.brokerOpenAt = open.filledAt ?? now;
        update.openBrokerTicket = open.brokerTicket;
        update.openFillPrice = open.fillPrice;
        update.openMt5Retcode = open.mt5Retcode;
        changed = true;
      } else if (open.status === "LIVE_REJECTED" || open.status === "LIVE_FAILED" || open.status === "LIVE_BLOCKED") {
        update.status = "OPEN_REJECTED";
        update.openMt5Retcode = open.mt5Retcode;
        update.openRejectionReason = open.rejectionReason ?? open.brokerMessage ?? open.status;
        update.blockReason = open.rejectionReason ?? open.brokerMessage ?? open.status;
        changed = true;
      }
    }
  }

  // OPEN_FILLED → CLOSE_DISPATCHED (auto-close, one-shot)
  if ((update.status ?? row.status) === "OPEN_FILLED" && !row.closeCommandId) {
    const openTicket = update.openBrokerTicket ?? row.openBrokerTicket;
    if (openTicket) {
      // position detected?
      const [pos] = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, args.userId),
        eq(arxLivePositionsTable.brokerTicket, openTicket),
      )).limit(1);
      if (pos && !row.positionDetectedAt) {
        update.positionDetectedAt = pos.lastSyncedAt ?? now;
        changed = true;
      }
      // queue the close (only once)
      const closeDraft = await createLiveOpsDraft({
        userId: args.userId, commandType: "CLOSE_LIVE_POSITION",
        brokerTicket: openTicket, symbol: row.symbol,
        side: row.side as "BUY" | "SELL", volume: Number(row.requestedVolume),
        sourcePage: "LIVE_TEST_CYCLE_AUTO_CLOSE",
      });
      if (!closeDraft.ok) {
        update.status = "CLOSE_FAILED_MANUAL_REQUIRED";
        update.closeRejectionReason = `${closeDraft.reason}${(closeDraft as { detail?: string }).detail ? `: ${(closeDraft as { detail?: string }).detail}` : ""}`;
        changed = true;
      } else {
        const closeCommandId = closeDraft.command.commandId;
        const closeConf = await confirmLiveCommand({ userId: args.userId, commandId: closeCommandId });
        if (!closeConf.ok) {
          update.status = "CLOSE_FAILED_MANUAL_REQUIRED";
          update.closeCommandId = closeCommandId;
          update.closeRejectionReason = `confirm_failed:${closeConf.reason}`;
          changed = true;
        } else {
          const closeDisp = await dispatchLiveCommand({ userId: args.userId, commandId: closeCommandId });
          const closeOk = (closeDisp as { ok?: boolean }).ok === true;
          if (!closeOk) {
            const primary = (closeDisp as { primaryReason?: string }).primaryReason ?? "CLOSE_DISPATCH_BLOCKED";
            update.status = "CLOSE_FAILED_MANUAL_REQUIRED";
            update.closeCommandId = closeCommandId;
            update.closeRejectionReason = primary;
            changed = true;
            await audit({
              eventType: "LIVE_TEST_CYCLE_CLOSE_BLOCKED", severity: "CRITICAL",
              userId: args.userId,
              message: `Live test cycle ${row.cycleId} CLOSE dispatch BLOCKED — manual close required at broker. ticket=${openTicket}`,
              metadata: { cycleId: row.cycleId, brokerTicket: openTicket, primaryReason: primary },
            });
            logger.warn({
              event: "LIVE_TEST_CYCLE_CLOSE_BLOCKED",
              cycleId: row.cycleId, userId: args.userId, ticket: openTicket, primaryReason: primary,
            }, "Live test cycle close blocked — manual intervention required");
          } else {
            const [closeCmd] = await db.select().from(arxLiveCommandsTable)
              .where(eq(arxLiveCommandsTable.commandId, closeCommandId)).limit(1);
            update.status = "CLOSE_DISPATCHED";
            update.closeCommandId = closeCommandId;
            update.closeQueuedAt = closeCmd?.sentToMt5At ?? now;
            changed = true;
            await audit({
              eventType: "LIVE_TEST_CYCLE_CLOSE_DISPATCHED",
              userId: args.userId,
              message: `Live test cycle ${row.cycleId} CLOSE dispatched ticket=${openTicket} cmd=${closeCommandId}`,
              metadata: { cycleId: row.cycleId, brokerTicket: openTicket, closeCommandId },
            });
          }
        }
      }
    }
  }

  // CLOSE_DISPATCHED → COMPLETED / CLOSE_FAILED_MANUAL_REQUIRED
  if ((update.status ?? row.status) === "CLOSE_DISPATCHED" && (update.closeCommandId ?? row.closeCommandId)) {
    const cid = (update.closeCommandId ?? row.closeCommandId)!;
    const [close] = await db.select().from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, cid)).limit(1);
    if (close) {
      if (!row.eaPickedCloseAt && !update.eaPickedCloseAt && close.pickedByEaAt) {
        update.eaPickedCloseAt = close.pickedByEaAt; changed = true;
      }
      // Task #402 — real close-evidence gate. A terminal-success close command
      // (LIVE_FILLED, retcode 10009) is NOT proof the position actually closed:
      // the EA can return success while the close did nothing (POSITION_NOT_FOUND
      // when positionTicket was 0). Resolve the close ONLY from real evidence —
      // the position's `closedAt` is stamped AND the command carries no error
      // reason — INDEPENDENT of the retcode value. A phantom close must never
      // mark the cycle COMPLETED / surface to the user as "executed".
      const openTicket = update.openBrokerTicket ?? row.openBrokerTicket;
      const closePosRows = openTicket
        ? await db.select({ closedAt: arxLivePositionsTable.closedAt })
            .from(arxLivePositionsTable).where(and(
              eq(arxLivePositionsTable.userId, args.userId),
              eq(arxLivePositionsTable.brokerTicket, openTicket),
            )).limit(1)
        : [];
      const closePos = closePosRows[0];
      const closeEvidence = resolveLiveCloseConfirmation({
        positionClosedAt: closePos?.closedAt ?? null,
        commandStatus: close.status,
        rejectionReason: close.rejectionReason,
        mt5Retcode: close.mt5Retcode,
      });

      if (closeEvidence.closeConfirmed) {
        update.brokerCloseAt = close.filledAt ?? now;
        update.closeFillPrice = close.fillPrice;
        update.closeMt5Retcode = close.mt5Retcode;
        // Capture the EA version that closed the cycle. When the close
        // fill price is missing (pnlStatus=UNKNOWN), the UI uses this to
        // tell the operator a pre-v1.28 EA can't report it — upgrade to
        // v1.28. Best-effort: null if no bridge facts are available.
        const closeBridge = await loadBridgeFacts(args.userId).catch(() => null);
        update.reportedEaVersion = closeBridge?.eaVersion ?? null;
        // closeEvidence already proved closedAt is stamped.
        update.positionRemovedAt = closePos?.closedAt ?? now;
        update.status = "COMPLETED";
        update.completedAt = now;

        const openFill = update.openFillPrice ?? row.openFillPrice;
        const closeFill = update.closeFillPrice ?? close.fillPrice;
        // Centralised guard: only compute realised P/L when BOTH fills
        // are valid (finite, > 0). On UNKNOWN we still mark COMPLETED
        // (the broker really did open and close the position) but
        // realisedPlUsd stays null and pnlStatus/dataQualityFlag flag
        // the row so no ledger / aggregate / learning input ingests it.
        const pnl = computeRealizedPnlUsd({
          side: row.side as "BUY" | "SELL",
          requestedVolume: Number(row.requestedVolume),
          openFillPrice: openFill,
          closeFillPrice: closeFill,
        });
        update.realizedPlUsd = pnl.realizedPlUsd;
        update.pnlStatus = pnl.pnlStatus;
        update.dataQualityFlag = pnl.dataQualityFlag;
        changed = true;

        const rawClosePayload = {
          commandId: close.commandId,
          status: close.status,
          fillPrice: close.fillPrice,
          filledAt: close.filledAt,
          mt5Retcode: close.mt5Retcode,
          brokerMessage: close.brokerMessage,
          brokerTicket: close.brokerTicket,
        };
        await audit({
          eventType: "LIVE_TEST_CYCLE_COMPLETED",
          userId: args.userId,
          message: `Live test cycle ${row.cycleId} COMPLETED pnlStatus=${pnl.pnlStatus} realizedPlUsd=${pnl.realizedPlUsd ?? "?"}${pnl.dataQualityFlag ? ` flag=${pnl.dataQualityFlag}` : ""}`,
          metadata: {
            cycleId: row.cycleId,
            openFillPrice: openFill, closeFillPrice: closeFill,
            realizedPlUsd: pnl.realizedPlUsd,
            pnlStatus: pnl.pnlStatus,
            dataQualityFlag: pnl.dataQualityFlag,
            rawClosePayload,
          },
        });
        if (pnl.pnlStatus === "UNKNOWN") {
          await audit({
            eventType: "LIVE_TEST_CYCLE_PNL_UNKNOWN", severity: "WARNING",
            userId: args.userId,
            message: `Live test cycle ${row.cycleId} completed but realised P/L is UNKNOWN (${pnl.dataQualityFlag}). The broker open + close succeeded; the EA close-result did not include a valid close fill price so no P/L can be trusted.`,
            metadata: {
              cycleId: row.cycleId,
              dataQualityFlag: pnl.dataQualityFlag,
              openFillPrice: openFill,
              closeFillPriceReported: close.fillPrice,
              brokerTicket: openTicket,
              rawClosePayload,
            },
          });
          logger.warn({
            event: "LIVE_TEST_CYCLE_PNL_UNKNOWN",
            cycleId: row.cycleId, userId: args.userId,
            dataQualityFlag: pnl.dataQualityFlag,
            closeFillPriceReported: close.fillPrice,
          }, "Live test cycle completed without a valid close fill price — realised P/L marked UNKNOWN.");
        }
      } else if (close.status === "LIVE_FILLED" && hasCloseErrorReason({ rejectionReason: close.rejectionReason })) {
        // Task #402 — phantom close. The bridge returned a terminal-success
        // status but the command STILL carries an error reason (e.g.
        // POSITION_NOT_FOUND from a retcode-10009 close that did nothing). The
        // position was never closed: flag for manual review, never COMPLETED.
        update.status = "CLOSE_FAILED_MANUAL_REQUIRED";
        update.closeMt5Retcode = close.mt5Retcode;
        update.closeRejectionReason = close.rejectionReason ?? close.brokerMessage ?? "CLOSE_EVIDENCE_UNCONFIRMED";
        changed = true;
        await audit({
          eventType: "LIVE_TEST_CYCLE_CLOSE_PHANTOM", severity: "CRITICAL",
          userId: args.userId,
          message: `Live test cycle ${row.cycleId} close reported terminal-success but carries an error reason — phantom close, manual verification required at broker.`,
          metadata: {
            cycleId: row.cycleId, closeStatus: close.status,
            retcode: close.mt5Retcode,
            rejectionReason: close.rejectionReason,
            brokerMessage: close.brokerMessage,
            closeConfirmationReason: closeEvidence.reason,
          },
        });
        logger.warn({
          event: "LIVE_TEST_CYCLE_CLOSE_PHANTOM",
          cycleId: row.cycleId, userId: args.userId,
          retcode: close.mt5Retcode, rejectionReason: close.rejectionReason,
        }, "Live test cycle close reported success but carries an error reason — phantom close, manual intervention required.");
      } else if (close.status === "LIVE_FILLED") {
        // Task #402 — terminal-success close but the position's closedAt is
        // not yet stamped (and no error reason). This is a sync-timing gap, not
        // a confirmed close: stay in CLOSE_DISPATCHED (pending). A later poll
        // re-checks once the position-sync reconciliation stamps closedAt, then
        // the closeEvidence.closeConfirmed branch above marks COMPLETED. No
        // state change here — never report a close we cannot yet prove.
      } else if (close.status === "LIVE_REJECTED" || close.status === "LIVE_FAILED" || close.status === "LIVE_BLOCKED") {
        update.status = "CLOSE_FAILED_MANUAL_REQUIRED";
        update.closeMt5Retcode = close.mt5Retcode;
        update.closeRejectionReason = close.rejectionReason ?? close.brokerMessage ?? close.status;
        changed = true;
        await audit({
          eventType: "LIVE_TEST_CYCLE_CLOSE_REJECTED", severity: "CRITICAL",
          userId: args.userId,
          message: `Live test cycle ${row.cycleId} CLOSE rejected at broker — manual close required.`,
          metadata: { cycleId: row.cycleId, closeStatus: close.status, retcode: close.mt5Retcode },
        });
      }
    }
  }

  if (!changed) return row;
  const [next] = await db.update(arxLiveTestCyclesTable).set(update)
    .where(eq(arxLiveTestCyclesTable.cycleId, args.cycleId)).returning();
  // recurse once — if we just transitioned to OPEN_FILLED we want to
  // queue CLOSE in the same call.
  if (next && !ARX_LIVE_TEST_CYCLE_TERMINAL.includes(next.status as ArxLiveTestCycleStatus)
      && next.status !== row.status) {
    return advanceCycle(args);
  }
  return next ?? null;
}

export async function getCurrentCycle(userId: number): Promise<ArxLiveTestCycle | null> {
  const rows = await db.select().from(arxLiveTestCyclesTable)
    .where(eq(arxLiveTestCyclesTable.userId, userId))
    .orderBy(desc(arxLiveTestCyclesTable.id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (ARX_LIVE_TEST_CYCLE_TERMINAL.includes(row.status as ArxLiveTestCycleStatus)) return row;
  return advanceCycle({ userId, cycleId: row.cycleId });
}

export async function getCycleById(args: { userId: number; cycleId: string }): Promise<ArxLiveTestCycle | null> {
  const [row] = await db.select().from(arxLiveTestCyclesTable).where(and(
    eq(arxLiveTestCyclesTable.cycleId, args.cycleId),
    eq(arxLiveTestCyclesTable.userId, args.userId),
  )).limit(1);
  if (!row) return null;
  if (ARX_LIVE_TEST_CYCLE_TERMINAL.includes(row.status as ArxLiveTestCycleStatus)) return row;
  return advanceCycle({ userId: args.userId, cycleId: args.cycleId });
}

/** Operator manual resolution for a stuck or failed cycle. Marks it
 *  CLOSE_FAILED_MANUAL_REQUIRED if not already terminal, with a note. */
export async function manualResolveCycle(args: { userId: number; cycleId: string; note: string }) {
  const [row] = await db.select().from(arxLiveTestCyclesTable).where(and(
    eq(arxLiveTestCyclesTable.cycleId, args.cycleId),
    eq(arxLiveTestCyclesTable.userId, args.userId),
  )).limit(1);
  if (!row) return { ok: false as const, reason: "CYCLE_NOT_FOUND" };
  const isTerminal = ARX_LIVE_TEST_CYCLE_TERMINAL.includes(row.status as ArxLiveTestCycleStatus);
  const [updated] = await db.update(arxLiveTestCyclesTable).set({
    status: isTerminal ? row.status : "CLOSE_FAILED_MANUAL_REQUIRED",
    manualResolveNote: args.note,
    manualResolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(arxLiveTestCyclesTable.cycleId, args.cycleId)).returning();
  await audit({
    eventType: "LIVE_TEST_CYCLE_MANUAL_RESOLVE", severity: "WARNING",
    userId: args.userId,
    message: `Live test cycle ${args.cycleId} manually resolved: ${args.note}`,
    metadata: { cycleId: args.cycleId, previousStatus: row.status, note: args.note },
  });
  return { ok: true as const, cycle: updated! };
}
