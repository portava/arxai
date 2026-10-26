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

import {
  livePositionLedger,
  livePositionColumns,
} from "../positions/ledger.js";
import { and, eq, sql } from "drizzle-orm";
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
import {
  readManagementMemory,
  resolvePendingManagement,
  stopAtLeastAsProtective,
  type ManagementMemory,
  type PendingManagement,
} from "./executionLifecycle.js";

export interface ManagePositionsResult {
  evaluated: number;
  modified: number;
  closed: number;
  alerted: number;
  held: number;
}

// One durable claim per execution. Compare-and-set prevents overlapping cycles
// from issuing the same stop/close twice, without holding a DB transaction open
// over the broker pipeline. An uncertain submission keeps its claim for review.
async function updateManagement(
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

/**
 * Evaluate + (for L3+) act on every open position owned by this agent.
 */
export async function manageAgentPositions(
  agent: SelfTradeAgent,
  actorUserId?: number | null,
  actorRole?: string | null,
): Promise<ManagePositionsResult> {
  const result: ManagePositionsResult = {
    evaluated: 0,
    modified: 0,
    closed: 0,
    alerted: 0,
    held: 0,
  };

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

    // The real broker position must exist — never manage a phantom.
    const [pos] = await livePositionLedger.read({
      where: and(
        eq(livePositionColumns.userId, e.executingUserId),
        eq(livePositionColumns.brokerTicket, e.brokerTicket),
      ),
      limit: 1,
    });
    if (!pos || pos.closedAt != null) continue;

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
    // Position Guardian rule "self-trade-manage": every modify/close is checked
    // against the guardian registry (never a widened stop) before the router.
    const guardedPosition = {
      side: (e.side === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
      stopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : null,
      takeProfit: pos.takeProfit != null ? Number(pos.takeProfit) : null,
    };

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

    let submissionStarted = false;
    try {
      await writeSelfTradeAudit(db, {
        agentId: agent.id,
        eventType: "MANAGEMENT_DISPATCH_INTENT",
        actorUserId: actorUserId ?? null,
        actorRole: actorRole ?? null,
        severity: "INFO",
        afterState: {
          executionId: e.id,
          action,
          claimId: claim.claimId,
          stopLoss: claim.stopLoss,
        },
        reason: verdict.reason,
      });
      submissionStarted = true;
      const res = await guardianInstantManage({
        ruleId: "self-trade-manage",
        userId: e.executingUserId,
        position: guardedPosition,
        intent: {
          source: "self_trade",
          action: action === "EXIT" ? "CLOSE" : "MODIFY_SL_TP",
          accountMode: "live",
          positionId: e.brokerTicket,
          ...(action === "EXIT" ? {} : { newStopLoss: claim.stopLoss }),
          oneClick: true,
          selfTradeAgentId: agent.id,
          selfTradeDecisionId: e.decisionId,
          selfTradeAgentKey: agent.agentKey,
        },
      });
      if (!res.ok && !res.commandId) {
        // Ops returns the command ID on every refusal after draft creation.
        // Without one, this returned refusal happened before a command existed.
        await updateManagement(e, claimed, mgmt);
        logger.warn(
          { executionId: e.id, error: res.error },
          "self-trade: management refused",
        );
        result.held++;
        continue;
      }
      if (!res.commandId) {
        logger.error(
          { executionId: e.id, claimId: claim.claimId },
          "self-trade: management accepted without command evidence; review required",
        );
        result.held++;
        continue;
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
        actorUserId: actorUserId ?? null,
        actorRole: actorRole ?? null,
        severity: "INFO",
        afterState: { executionId: e.id, commandId: res.commandId, action },
        reason: res.ok
          ? "Management request dispatched; awaiting broker confirmation."
          : "Management request refused with command evidence; awaiting reconciliation.",
      });
      // Submission is not a completed modification or close. The next cycle
      // advances it only from command evidence plus broker position truth.
    } catch (err) {
      // Audit failed before calling the pipeline: non-submission is certain.
      if (!submissionStarted) await updateManagement(e, claimed, mgmt);
      logger.error(
        { err, executionId: e.id, claimId: claim.claimId },
        submissionStarted
          ? "self-trade: management outcome uncertain; claim retained for review"
          : "self-trade: management audit unavailable; no command submitted",
      );
      result.held++;
    }
  }

  return result;
}
