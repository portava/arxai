// Self-Trade AI — Live Position Manager (Task #213).
//
// Manages an agent's REAL open positions (FILLED executions) using the PURE
// `evaluateManagementAction`, riding the EXISTING executeInstant pipeline for
// MODIFY_SL_TP / CLOSE. Autonomy decides who acts:
//   L0/L1 — never reach here.
//   L2    — alert only (no autonomous management).
//   L3+   — autonomous MOVE_TO_BE / TIGHTEN_SL / EXIT.
// TAKE_PARTIAL is alert-only everywhere (the instant pipeline has no partial
// path; we never invent one).
//
// SAFETY (inviolable):
// - No new MT5 path, no gate bypass. Every modify/close goes through the
//   Position Guardian (lib/positionGuardian/manage.ts) to executeInstant →
//   16-gate Phase B pipeline. Risk-reducing actions are allowed under a kill
//   switch because the live pipeline itself enforces what is permitted.
// - We only manage a position when the REAL broker row (arx_live_positions)
//   exists; if it is absent we skip (never act on a phantom).
// - A stale broker snapshot holds. The protective-action path
//   (protectiveActionPath.ts) starts FROM that hold and never uses the refused
//   observation: it may act only on a strictly newer, sweep-written row that
//   passes a stricter standard (owner decision 2026-10-27).

import {
  livePositionLedger,
  livePositionColumns,
} from "../positions/ledger.js";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
  arxLiveCommandsTable,
  type SelfTradeAgent,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import {
  evaluateManagementAction,
  type TradeThesis,
} from "@workspace/domain/self-trade";
import { logger } from "../logger.js";
import { guardianInstantManage } from "../positionGuardian/manage.js";
import { writeSelfTradeAudit } from "./audit.js";
import { evaluatePositionObservation } from "./freshFacts.js";
import {
  ownedEntryBinding,
  sameBrokerAccount,
  fullVolumeEvidence,
  readManagementMemory,
  resolvePendingManagement,
  stopAtLeastAsProtective,
  type ManagementMemory,
  type PendingManagement,
} from "./executionLifecycle.js";
import {
  runProtectiveActionPath,
  type ProtectivePathDeps,
  type ProtectiveSharedDeadline,
} from "./protectiveActionPath.js";

export interface ManagePositionsResult {
  evaluated: number;
  modified: number;
  closed: number;
  alerted: number;
  held: number;
  /** Structured reasons for holds that refused to act on the observation. */
  heldReasons: Record<string, number>;
  /**
   * Protective-action path (started from observation holds). `held` /
   * `evaluated` / `heldReasons` above keep their ordinary meaning; a protective
   * dispatch is still counted there as the hold it started from.
   */
  protective: {
    considered: number;
    waitedMs: number;
    acted: number;
    held: Record<string, number>;
  };
}

export interface ManagePositionsOptions {
  /** Injectable seams for the protective path (tests); production uses the defaults. */
  protective?: ProtectivePathDeps;
}

// One durable claim per execution. Compare-and-set prevents overlapping cycles
// from issuing the same stop/close twice, without holding a DB transaction open
// over the broker pipeline. An uncertain submission keeps its claim for review.
export async function updateManagement(
  execution: SelfTradeAgentExecution,
  before: unknown,
  memory: ManagementMemory,
  confirmedStop?: number,
): Promise<boolean> {
  const rows = await db
    .update(selfTradeAgentExecutionsTable)
    .set({
      managementState: memory,
      updatedAt: new Date(),
      ...(confirmedStop == null ? {} : { slPrice: confirmedStop }),
    })
    .where(
      and(
        eq(selfTradeAgentExecutionsTable.id, execution.id),
        eq(selfTradeAgentExecutionsTable.status, "FILLED"),
        sql`${selfTradeAgentExecutionsTable.managementState} = ${JSON.stringify(before)}::jsonb`,
      ),
    )
    .returning({ id: selfTradeAgentExecutionsTable.id });
  return rows.length === 1;
}

export type ClaimedDispatchOutcome =
  /** A command exists and the pipeline accepted it; awaiting broker confirmation. */
  | { outcome: "DISPATCHED"; commandId: string }
  /** A command exists but the pipeline refused after creating it; reconciliation settles it. */
  | { outcome: "REFUSED_WITH_COMMAND"; commandId: string; error: string }
  /** Refused before any command existed; the claim has been rolled back. */
  | { outcome: "REFUSED_WITHOUT_COMMAND"; error: string }
  /** Accepted without command evidence; the claim is retained for review. */
  | { outcome: "ACCEPTED_WITHOUT_EVIDENCE" }
  /** The pipeline threw after submission started; the claim is retained for review. */
  | { outcome: "UNCERTAIN"; error: unknown }
  /** The intent audit failed before the pipeline was called; the claim has been rolled back. */
  | { outcome: "AUDIT_FAILED"; error: unknown };

export interface ClaimedDispatchArgs {
  agent: SelfTradeAgent;
  execution: SelfTradeAgentExecution;
  /** The row the decision was taken on (exact ledger row id and current protection). */
  position: { id: number; stopLoss: number | null; takeProfit: number | null };
  /** The claim already written by compare-and-set. */
  claim: PendingManagement;
  /** Memory before the claim (restored on a refusal without a command). */
  memory: ManagementMemory;
  /** Memory with the claim (the CAS "before" for the command link). */
  claimed: ManagementMemory;
  reason: string;
  actorUserId?: number | null;
  actorRole?: string | null;
  /** Explicit take-profit on a stop move (protective path pins it); omitted keeps the pipeline default. */
  newTakeProfit?: number | null;
  /** Extra fields recorded on the MANAGEMENT_DISPATCH_INTENT audit row. */
  auditAfterState?: Record<string, unknown>;
}

/**
 * Dispatch a management request whose claim is already taken: audit the
 * intent, hand it to the Position Guardian (→ executeInstant → every live
 * gate), then record the outcome. Shared by the ordinary path and the
 * protective path; neither writes a command or talks to the broker itself.
 */
export async function dispatchClaimedManagement(
  args: ClaimedDispatchArgs,
): Promise<ClaimedDispatchOutcome> {
  const { agent, execution: e, position, claim, memory, claimed } = args;
  const action = claim.action;
  let submissionStarted = false;
  try {
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: "MANAGEMENT_DISPATCH_INTENT",
      actorUserId: args.actorUserId ?? null,
      actorRole: args.actorRole ?? null,
      severity: "INFO",
      afterState: {
        executionId: e.id,
        action,
        claimId: claim.claimId,
        stopLoss: claim.stopLoss,
        ...(args.auditAfterState ?? {}),
      },
      reason: args.reason,
    });
    submissionStarted = true;
    const res = await guardianInstantManage({
      ruleId: "self-trade-manage",
      userId: e.executingUserId!,
      position: {
        side: (e.side === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
      },
      intent: {
        source: "self_trade",
        action: action === "EXIT" ? "CLOSE" : "MODIFY_SL_TP",
        accountMode: "live",
        positionId: e.brokerTicket!,
        selfTradeManagement: {
          executionId: e.id,
          positionRowId: position.id,
          claimId: claim.claimId,
        },
        ...(action === "EXIT"
          ? {}
          : {
              newStopLoss: claim.stopLoss,
              ...("newTakeProfit" in args ? { newTakeProfit: args.newTakeProfit } : {}),
            }),
        oneClick: true,
        selfTradeAgentId: agent.id,
        selfTradeDecisionId: e.decisionId,
        selfTradeAgentKey: agent.agentKey,
      },
    });
    if (!res.ok && !res.commandId) {
      // Ops returns the command ID on every refusal after draft creation.
      // Without one, this returned refusal happened before a command existed.
      await updateManagement(e, claimed, memory);
      logger.warn(
        { executionId: e.id, error: res.error },
        "self-trade: management refused",
      );
      return { outcome: "REFUSED_WITHOUT_COMMAND", error: res.error };
    }
    if (!res.commandId) {
      logger.error(
        { executionId: e.id, claimId: claim.claimId },
        "self-trade: management accepted without command evidence; review required",
      );
      return { outcome: "ACCEPTED_WITHOUT_EVIDENCE" };
    }
    const submitted: ManagementMemory = {
      ...claimed,
      pendingManagement: { ...claim, commandId: res.commandId },
      ...(action === "EXIT" ? { closeCommandId: res.commandId } : {}),
    };
    await updateManagement(e, claimed, submitted);
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: !res.ok
        ? "MANAGEMENT_REFUSAL_WITH_COMMAND"
        : action === "EXIT"
          ? "MANAGEMENT_EXIT_DISPATCH"
          : "MANAGEMENT_STOP_DISPATCH",
      actorUserId: args.actorUserId ?? null,
      actorRole: args.actorRole ?? null,
      severity: "INFO",
      afterState: {
        executionId: e.id,
        commandId: res.commandId,
        action,
        ...(claim.protective ? { protective: claim.protective.trigger } : {}),
      },
      reason: res.ok
        ? "Management request dispatched; awaiting broker confirmation."
        : "Management request refused with command evidence; awaiting reconciliation.",
    });
    // Submission is not a completed modification or close. The next cycle
    // advances it only from command evidence plus broker position truth.
    return res.ok
      ? { outcome: "DISPATCHED", commandId: res.commandId }
      : { outcome: "REFUSED_WITH_COMMAND", commandId: res.commandId, error: res.error };
  } catch (err) {
    // Audit failed before calling the pipeline: non-submission is certain.
    if (!submissionStarted) await updateManagement(e, claimed, memory);
    logger.error(
      { err, executionId: e.id, claimId: claim.claimId },
      submissionStarted
        ? "self-trade: management outcome uncertain; claim retained for review"
        : "self-trade: management audit unavailable; no command submitted",
    );
    return submissionStarted
      ? { outcome: "UNCERTAIN", error: err }
      : { outcome: "AUDIT_FAILED", error: err };
  }
}

/** A dispatch that produced no command evidence counts as a hold for the cycle. */
function dispatchHeld(outcome: ClaimedDispatchOutcome): boolean {
  return outcome.outcome !== "DISPATCHED" && outcome.outcome !== "REFUSED_WITH_COMMAND";
}

/**
 * Evaluate + (for L3+) act on every open position owned by this agent.
 */
export async function manageAgentPositions(
  agent: SelfTradeAgent,
  actorUserId?: number | null,
  actorRole?: string | null,
  options: ManagePositionsOptions = {},
): Promise<ManagePositionsResult> {
  const result: ManagePositionsResult = {
    evaluated: 0,
    modified: 0,
    closed: 0,
    alerted: 0,
    held: 0,
    heldReasons: {},
    protective: { considered: 0, waitedMs: 0, acted: 0, held: {} },
  };
  // One sweep refreshes every row on a bridge, so every held position in this
  // call shares one evidence deadline.
  const protectiveDeadline: ProtectiveSharedDeadline = { deadlineMs: null };

  const filled = await db
    .select()
    .from(selfTradeAgentExecutionsTable)
    .where(
      and(
        eq(selfTradeAgentExecutionsTable.agentId, agent.id),
        eq(selfTradeAgentExecutionsTable.status, "FILLED"),
      ),
    );
  if (filled.length === 0) return result;

  for (const e of filled) {
    if (!e.brokerTicket || e.executingUserId == null) continue;

    // Resolve exact broker identity from the attributed entry, never from a
    // fuzzy symbol alias or a ticket that could be reused on another account.
    const entryCommand = e.commandId
      ? (
          await db
            .select()
            .from(arxLiveCommandsTable)
            .where(eq(arxLiveCommandsTable.commandId, e.commandId))
            .limit(1)
        )[0]
      : undefined;
    const entry = ownedEntryBinding(e, entryCommand);
    if (
      !entry ||
      !sameBrokerAccount(entry, entry) ||
      !fullVolumeEvidence(entry, e.intendedVolume)
    ) {
      result.held++;
      continue;
    }

    // The real broker position must exist — never manage a phantom.
    const [pos] = await livePositionLedger.read({
      where: and(
        eq(livePositionColumns.userId, e.executingUserId),
        eq(livePositionColumns.brokerTicket, e.brokerTicket),
        eq(livePositionColumns.bridgeConnectionId, entry.bridgeConnectionId!),
        eq(livePositionColumns.accountLogin, entry.accountLogin!),
        eq(livePositionColumns.brokerServer, entry.brokerServer!),
        eq(livePositionColumns.symbol, entry.symbol),
      ),
      limit: 1,
    });
    if (!pos || pos.closedAt != null) continue;
    if (
      !sameBrokerAccount(entry, pos) ||
      pos.symbol !== entry.symbol ||
      pos.userId !== e.executingUserId ||
      pos.brokerTicket !== e.brokerTicket
    ) {
      result.held++;
      continue;
    }

    const decision =
      e.decisionId != null
        ? (
            await db
              .select()
              .from(selfTradeDecisionsTable)
              .where(eq(selfTradeDecisionsTable.id, e.decisionId))
              .limit(1)
          )[0]
        : undefined;
    const thesis = (decision?.thesis as TradeThesis | null) ?? null;

    const currentPrice =
      pos.currentPrice != null ? Number(pos.currentPrice) : null;
    const entryPrice = pos.entryPrice != null ? Number(pos.entryPrice) : null;
    if (currentPrice == null || entryPrice == null) continue;

    const mgmt = readManagementMemory(e.managementState);
    // Older EXIT records have a closeCommandId but no claim envelope. They are
    // still in flight until the linked command proves an outcome.
    const pending =
      mgmt.pendingManagement ??
      (mgmt.closeCommandId
        ? {
            claimId: "legacy-close",
            action: "EXIT" as const,
            requestedAt: e.updatedAt.toISOString(),
            stopLoss: null,
            commandId: mgmt.closeCommandId,
          }
        : undefined);
    if (pending) {
      const command = pending.commandId
        ? (
            await db
              .select()
              .from(arxLiveCommandsTable)
              .where(eq(arxLiveCommandsTable.commandId, pending.commandId))
              .limit(1)
          )[0]
        : undefined;
      const observedStop = pos.stopLoss != null ? Number(pos.stopLoss) : null;
      const resolution = resolvePendingManagement(
        e,
        pending,
        command,
        observedStop,
        entryCommand,
      );
      if (resolution === "WAIT") {
        result.held++;
        continue;
      }
      const next: ManagementMemory = { ...mgmt };
      delete next.pendingManagement;
      if (pending.action === "EXIT") delete next.closeCommandId;
      if (resolution === "CONFIRMED") {
        next.beMoved = stopAtLeastAsProtective(
          e.side,
          observedStop,
          entryPrice,
        );
        next.lastAction = pending.action;
      }
      const advanced = await updateManagement(
        e,
        e.managementState,
        next,
        resolution === "CONFIRMED" ? (observedStop ?? undefined) : undefined,
      );
      if (advanced && resolution === "CONFIRMED") result.modified++;
      else result.held++;
      continue;
    }
    // Fresh facts: act only on a current broker snapshot that already reflects
    // every broker-affecting command on this ticket (entry fill, and any
    // close/modify that was actually sent, including manual ones).
    const readTicketCommands = () =>
      db
        .select({
          sentToMt5At: arxLiveCommandsTable.sentToMt5At,
          filledAt: arxLiveCommandsTable.filledAt,
          rejectedAt: arxLiveCommandsTable.rejectedAt,
        })
        .from(arxLiveCommandsTable)
        .where(
          and(
            eq(arxLiveCommandsTable.userId, e.executingUserId!),
            inArray(arxLiveCommandsTable.commandType, [
              "CLOSE_LIVE_POSITION",
              "MODIFY_LIVE_SLTP",
            ]),
            sql`${arxLiveCommandsTable.payload}->>'brokerTicket' = ${e.brokerTicket}`,
            isNotNull(arxLiveCommandsTable.sentToMt5At),
          ),
        );
    const ticketCommands = await readTicketCommands();
    const nowMs = Date.now();
    const observation = evaluatePositionObservation({
      lastSyncedAt: pos.lastSyncedAt,
      currentPrice: pos.currentPrice,
      commandEventTimes: [
        entryCommand?.filledAt,
        ...ticketCommands.flatMap((c) => [c.sentToMt5At, c.filledAt, c.rejectedAt]),
      ],
      nowMs,
    });
    if (!observation.ok) {
      result.held++;
      result.heldReasons[observation.reason] =
        (result.heldReasons[observation.reason] ?? 0) + 1;
      logger.warn(
        { executionId: e.id, reason: observation.reason, detail: observation.detail },
        "self-trade: management held on position observation",
      );
      // Protective-action path: not a bypass. The refused observation above is
      // never used to act; the path waits for a strictly newer complete sweep
      // and re-verifies identity and geometry against that row before any claim.
      try {
        const protective = await runProtectiveActionPath(
          {
            agent,
            execution: e,
            entry,
            position: pos,
            thesis,
            memory: mgmt,
            holdReason: observation.reason,
            heldAtMs: nowMs,
            actorUserId,
            actorRole,
            sharedDeadline: protectiveDeadline,
          },
          { readTicketCommands, ...(options.protective ?? {}) },
        );
        if (protective.status === "DISPATCHED") {
          result.protective.considered++;
          result.protective.waitedMs += protective.waitedMs;
          result.protective.acted++;
        } else if (protective.status === "HELD") {
          result.protective.considered++;
          result.protective.waitedMs += protective.waitedMs;
          result.protective.held[protective.reason] =
            (result.protective.held[protective.reason] ?? 0) + 1;
        }
      } catch (err) {
        // The path fails closed on its own; this only keeps the cycle alive.
        logger.error({ err, executionId: e.id }, "self-trade: protective path threw");
        result.protective.held.PROTECTIVE_HOLD_INTERNAL_ERROR =
          (result.protective.held.PROTECTIVE_HOLD_INTERNAL_ERROR ?? 0) + 1;
      }
      continue;
    }

    const verdict = evaluateManagementAction({
      side: e.side as "BUY" | "SELL",
      entryPrice,
      currentPrice,
      stopLoss: thesis?.stopLoss ?? (e.slPrice != null ? e.slPrice : null),
      currentSl: pos.stopLoss != null ? Number(pos.stopLoss) : null,
      takeProfits: thesis?.takeProfits ?? [],
      invalidation: thesis?.invalidation ?? null,
      // Broker protection is authoritative, including manually moved stops.
      // Old versions set beMoved before the broker actually accepted the move.
      beMoved: stopAtLeastAsProtective(
        e.side,
        pos.stopLoss != null ? Number(pos.stopLoss) : null,
        entryPrice,
      ),
      partialsTaken: mgmt.partialsTaken ?? 0,
      autonomyLevel: agent.autonomyLevel,
    });
    result.evaluated++;

    if (verdict.action === "HOLD") {
      result.held++;
      continue;
    }

    // L2 (or below): alert only — no autonomous management.
    if (agent.autonomyLevel < 3) {
      await writeSelfTradeAudit(db, {
        agentId: agent.id,
        eventType: "MANAGEMENT_ALERT",
        actorUserId: actorUserId ?? null,
        actorRole: actorRole ?? null,
        severity: "INFO",
        afterState: {
          executionId: e.id,
          suggested: verdict.action,
          reason: verdict.reason,
          rMultiple: verdict.rMultiple,
        },
        reason: `Suggested ${verdict.action} (L${agent.autonomyLevel} alert-only).`,
      });
      result.alerted++;
      continue;
    }

    // TAKE_PARTIAL has no instant-pipeline path — alert, never fabricate.
    if (verdict.action === "TAKE_PARTIAL") {
      await writeSelfTradeAudit(db, {
        agentId: agent.id,
        eventType: "MANAGEMENT_ALERT",
        actorUserId: actorUserId ?? null,
        actorRole: actorRole ?? null,
        severity: "INFO",
        afterState: {
          executionId: e.id,
          suggested: "TAKE_PARTIAL",
          reason: verdict.reason,
        },
        reason: "Suggested TAKE_PARTIAL (no autonomous partial path).",
      });
      result.alerted++;
      continue;
    }

    const action = verdict.action;
    if (action !== "EXIT" && action !== "MOVE_TO_BE" && action !== "TIGHTEN_SL")
      continue;
    if (action !== "EXIT" && verdict.newStopLoss == null) continue;

    const claim: PendingManagement = {
      claimId: randomUUID(),
      action,
      requestedAt: new Date().toISOString(),
      stopLoss: action === "EXIT" ? null : verdict.newStopLoss,
    };
    const claimed: ManagementMemory = { ...mgmt, pendingManagement: claim };
    if (!(await updateManagement(e, e.managementState, claimed))) {
      result.held++;
      continue;
    }

    // Position Guardian rule "self-trade-manage": every modify/close is checked
    // against the guardian registry (never a widened stop) before the router.
    const outcome = await dispatchClaimedManagement({
      agent,
      execution: e,
      position: {
        id: pos.id,
        stopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : null,
        takeProfit: pos.takeProfit != null ? Number(pos.takeProfit) : null,
      },
      claim,
      memory: mgmt,
      claimed,
      reason: verdict.reason,
      actorUserId,
      actorRole,
    });
    if (dispatchHeld(outcome)) result.held++;
  }

  return result;
}
