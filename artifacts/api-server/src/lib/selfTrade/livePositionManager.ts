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
// - No new MT5 path, no gate bypass. Every modify/close rides executeInstant →
//   16-gate Phase B pipeline. Risk-reducing actions are allowed under a kill
//   switch because the live pipeline itself enforces what is permitted.
// - We only manage a position when the REAL broker row (arx_live_positions)
//   exists; if it is absent we skip (never act on a phantom).

import { and, eq } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  selfTradeDecisionsTable,
  arxLivePositionsTable,
  type SelfTradeAgent,
} from "@workspace/db";
import {
  evaluateManagementAction,
  checkAutomatedCommandAllowed,
  type TradeThesis,
  type ManagementAction,
} from "@workspace/domain/self-trade";
import { logger } from "../logger.js";
import { executeInstant } from "../live/instantTrade.js";
import { writeSelfTradeAudit } from "./audit.js";

export interface ManagePositionsResult {
  evaluated: number;
  modified: number;
  closed: number;
  alerted: number;
  held: number;
}

interface ManagementMemory {
  beMoved?: boolean;
  partialsTaken?: number;
  lastAction?: ManagementAction;
  closeCommandId?: string;
}

/**
 * Evaluate + (for L3+) act on every open position owned by this agent.
 */
export async function manageAgentPositions(
  agent: SelfTradeAgent,
  actorUserId?: number | null,
  actorRole?: string | null,
): Promise<ManagePositionsResult> {
  const result: ManagePositionsResult = { evaluated: 0, modified: 0, closed: 0, alerted: 0, held: 0 };

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
    const [pos] = await db
      .select()
      .from(arxLivePositionsTable)
      .where(
        and(
          eq(arxLivePositionsTable.userId, e.executingUserId),
          eq(arxLivePositionsTable.brokerTicket, e.brokerTicket),
        ),
      )
      .limit(1);
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

    const currentPrice = pos.currentPrice != null ? Number(pos.currentPrice) : null;
    const entryPrice = pos.entryPrice != null ? Number(pos.entryPrice) : null;
    if (currentPrice == null || entryPrice == null) continue;

    const mgmt = (e.managementState ?? {}) as ManagementMemory;

    const verdict = evaluateManagementAction({
      side: e.side as "BUY" | "SELL",
      entryPrice,
      currentPrice,
      stopLoss: thesis?.stopLoss ?? (e.slPrice != null ? e.slPrice : null),
      currentSl: pos.stopLoss != null ? Number(pos.stopLoss) : null,
      takeProfits: thesis?.takeProfits ?? [],
      invalidation: thesis?.invalidation ?? null,
      beMoved: mgmt.beMoved ?? false,
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
        afterState: { executionId: e.id, suggested: verdict.action, reason: verdict.reason, rMultiple: verdict.rMultiple },
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
        afterState: { executionId: e.id, suggested: "TAKE_PARTIAL", reason: verdict.reason },
        reason: "Suggested TAKE_PARTIAL (no autonomous partial path).",
      });
      result.alerted++;
      continue;
    }

    // Capability #44 — manual takeover gate. When the owner has explicitly
    // taken this position over (arx_live_positions.management_state =
    // MANUAL_CONTROL), autonomous ACTION refuses here — before any
    // executeInstant dispatch is composed — exactly as the missionExitManager
    // seam does. Alert-only paths above are monitoring/advisory and keep
    // running; only the automated MODIFY_SL_TP / CLOSE commands stop. The
    // total normalizer treats legacy/absent state as STRATEGY_MANAGED, so
    // pre-migration rows behave exactly as before.
    {
      const controlVerdict = checkAutomatedCommandAllowed(
        (pos as { managementState?: unknown }).managementState,
      );
      if (!controlVerdict.allowed) {
        logger.info(
          {
            agentId: agent.id,
            executionId: e.id,
            brokerTicket: e.brokerTicket,
            suppressed: verdict.action,
            reason: controlVerdict.reason,
          },
          "self-trade: automated management suppressed — position under manual control",
        );
        result.held++;
        continue;
      }
    }

    // L3+: MOVE_TO_BE / TIGHTEN_SL → modify the stop via the existing pipeline.
    if ((verdict.action === "MOVE_TO_BE" || verdict.action === "TIGHTEN_SL") && verdict.newStopLoss != null) {
      const res = await executeInstant({
        userId: e.executingUserId,
        intent: {
          source: "self_trade",
          action: "MODIFY_SL_TP",
          accountMode: "live",
          positionId: e.brokerTicket,
          newStopLoss: verdict.newStopLoss,
          oneClick: true,
          selfTradeAgentId: agent.id,
          selfTradeDecisionId: e.decisionId,
          selfTradeAgentKey: agent.agentKey,
        },
      });
      if (res.ok) {
        const nextMemory: ManagementMemory = {
          ...mgmt,
          beMoved: verdict.action === "MOVE_TO_BE" ? true : mgmt.beMoved ?? false,
          lastAction: verdict.action,
        };
        await db
          .update(selfTradeAgentExecutionsTable)
          .set({ slPrice: verdict.newStopLoss, managementState: nextMemory, updatedAt: new Date() })
          .where(eq(selfTradeAgentExecutionsTable.id, e.id));
        result.modified++;
      } else {
        logger.warn({ executionId: e.id, error: res.error }, "self-trade: modify SL failed");
      }
      continue;
    }

    // L3+: EXIT → close via the existing pipeline; record the close command id
    // so reconcile resolves the realized P/L from the REAL close fill.
    if (verdict.action === "EXIT") {
      const res = await executeInstant({
        userId: e.executingUserId,
        intent: {
          source: "self_trade",
          action: "CLOSE",
          accountMode: "live",
          positionId: e.brokerTicket,
          oneClick: true,
          selfTradeAgentId: agent.id,
          selfTradeDecisionId: e.decisionId,
          selfTradeAgentKey: agent.agentKey,
        },
      });
      if (res.ok) {
        const nextMemory: ManagementMemory = { ...mgmt, lastAction: "EXIT", closeCommandId: res.commandId };
        await db
          .update(selfTradeAgentExecutionsTable)
          .set({ managementState: nextMemory, updatedAt: new Date() })
          .where(eq(selfTradeAgentExecutionsTable.id, e.id));
        await writeSelfTradeAudit(db, {
          agentId: agent.id,
          eventType: "MANAGEMENT_EXIT_DISPATCH",
          actorUserId: actorUserId ?? null,
          actorRole: actorRole ?? null,
          severity: "INFO",
          afterState: { executionId: e.id, commandId: res.commandId, reason: verdict.reason },
          reason: "Dispatched autonomous EXIT (close) — awaiting real close fill.",
        });
        result.closed++;
      } else {
        logger.warn({ executionId: e.id, error: res.error }, "self-trade: exit close failed");
      }
      continue;
    }
  }

  return result;
}
