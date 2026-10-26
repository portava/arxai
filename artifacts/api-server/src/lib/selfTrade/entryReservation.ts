// Atomic agent admission. No broker/network operation runs inside this short
// transaction. A committed pending row is a durable capacity reservation, even
// when a process dies before storing a command link. Time never releases it.
import {
  hasUnresolvedAgentAccounting,
  ENTRY_ACCOUNTING_UNRESOLVED,
} from "./accountingHold.js";
import { writeSelfTradeAudit } from "./audit.js";
import { entryAuthoritySnapshot } from "./entryAuthority.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  selfTradeDecisionsTable,
  selfTradeAgentExecutionsTable,
  type SelfTradeAgent,
  type SelfTradeAgentSettings,
  type SelfTradeAgentLedger,
  type SelfTradeDecision,
  type SelfTradeAgentExecution,
} from "@workspace/db";

export interface EntryReservationInput {
  agent: SelfTradeAgent;
  settings: SelfTradeAgentSettings;
  ledger: SelfTradeAgentLedger | null;
  decision: SelfTradeDecision;
  executingUserId: number;
  side: "BUY" | "SELL";
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  now?: Date;
  actorUserId?: number | null;
  actorRole?: string | null;
}
export type EntryReservationResult =
  | { ok: true; execution: SelfTradeAgentExecution }
  | { ok: false; reason: string; duplicate?: boolean };

/** USER ownership never falls back to the creator of an orphaned user agent. */
export function entryOwnerId(agent: SelfTradeAgent): number | null {
  const id =
    agent.ownerType === "USER"
      ? agent.ownerId
      : agent.ownerType === "OPERATOR_FLEET" && agent.ownerId == null
        ? agent.createdByUserId
        : null;
  return Number.isInteger(id) && (id ?? 0) > 0 ? id : null;
}

export async function reserveAgentEntry(
  input: EntryReservationInput,
  database: typeof db = db,
): Promise<EntryReservationResult> {
  return database.transaction(async (tx) => {
    // Lock order shared with funding/defunding/P&L: agent, settings, ledger.
    // Row locking serializes distinct decisions from overlapping cycles too.
    const [agent] = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, input.agent.id))
      .for("update");
    if (!agent) return { ok: false, reason: "AGENT_NOT_FOUND" };
    if (entryOwnerId(agent) !== input.executingUserId)
      return { ok: false, reason: "ENTRY_OWNER_CHANGED" };
    if (
      agent.status !== "ACTIVE" ||
      agent.mode !== "LIVE" ||
      !Number.isInteger(agent.autonomyLevel) ||
      agent.autonomyLevel < 1 ||
      agent.autonomyLevel > 4
    )
      return { ok: false, reason: "AGENT_NOT_EXECUTABLE" };

    const [settings] = await tx
      .select()
      .from(selfTradeAgentSettingsTable)
      .where(eq(selfTradeAgentSettingsTable.agentId, agent.id))
      .for("update");
    const [ledger] = await tx
      .select()
      .from(selfTradeAgentLedgerTable)
      .where(eq(selfTradeAgentLedgerTable.agentId, agent.id))
      .for("update");
    const [decision] = await tx
      .select()
      .from(selfTradeDecisionsTable)
      .where(eq(selfTradeDecisionsTable.id, input.decision.id))
      .for("update");
    if (!settings || !ledger || !decision)
      return { ok: false, reason: "ENTRY_CONTEXT_MISSING" };
    if (
      decision.agentId !== agent.id ||
      decision.agentKey !== agent.agentKey ||
      decision.side !== input.side ||
      !["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"].includes(
        decision.outcome,
      )
    ) {
      return { ok: false, reason: "ENTRY_DECISION_MISMATCH" };
    }
    // The permission gate and sizer used these snapshots. Any intervening
    // mutation invalidates their answer rather than reusing stale permission.
    if (
      ![
        [agent, input.agent],
        [settings, input.settings],
        [ledger, input.ledger],
        [decision, input.decision],
      ].every(([current, expected]) => isDeepStrictEqual(current, expected))
    ) {
      return { ok: false, reason: "ENTRY_CONTEXT_CHANGED" };
    }
    const now = input.now ?? new Date();
    if (
      !Number.isFinite(now.getTime()) ||
      (decision.setupExpiresAt != null &&
        (!Number.isFinite(decision.setupExpiresAt.getTime()) ||
          decision.setupExpiresAt <= now))
    ) {
      return { ok: false, reason: "ENTRY_SETUP_EXPIRED" };
    }
    if (
      !Number.isFinite(ledger.allocatedFunds) ||
      ledger.allocatedFunds <= 0 ||
      !Number.isFinite(ledger.availableFunds) ||
      ledger.availableFunds <= 0
    ) {
      return { ok: false, reason: "ENTRY_NOT_FUNDED" };
    }
    if (
      !Number.isFinite(input.volume) ||
      input.volume <= 0 ||
      !Number.isFinite(settings.maxLotPerTrade) ||
      input.volume > settings.maxLotPerTrade
    )
      return { ok: false, reason: "ENTRY_INVALID_VOLUME" };
    const thesis = decision.thesis as {
      stopLoss?: unknown;
      takeProfits?: { from?: unknown }[];
    } | null;
    if (
      !thesis ||
      thesis.stopLoss !== input.stopLoss ||
      (thesis.takeProfits?.[0]?.from ?? null) !== input.takeProfit ||
      (settings.requireStopLoss &&
        (!Number.isFinite(input.stopLoss) || (input.stopLoss ?? 0) <= 0))
    ) {
      return { ok: false, reason: "ENTRY_PROTECTION_MISMATCH" };
    }

    if (await hasUnresolvedAgentAccounting(tx, agent.id))
      return { ok: false, reason: ENTRY_ACCOUNTING_UNRESOLVED };

    const idempotencyKey = `decision:${decision.id}`;
    // Terminal states remain consumed decisions. A fresh decision has a new ID;
    // cancellation/closure must never make the old decision executable again.
    const [prior] = await tx
      .select({ id: selfTradeAgentExecutionsTable.id })
      .from(selfTradeAgentExecutionsTable)
      .where(
        and(
          eq(selfTradeAgentExecutionsTable.agentId, agent.id),
          eq(selfTradeAgentExecutionsTable.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (prior)
      return {
        ok: false,
        reason: "ENTRY_DECISION_ALREADY_RESERVED",
        duplicate: true,
      };

    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const capacityRows = await tx
      .select({
        status: selfTradeAgentExecutionsTable.status,
        filledAt: selfTradeAgentExecutionsTable.filledAt,
      })
      .from(selfTradeAgentExecutionsTable)
      .where(
        and(
          eq(selfTradeAgentExecutionsTable.agentId, agent.id),
          or(
            inArray(selfTradeAgentExecutionsTable.status, [
              "PENDING_TICKET",
              "DISPATCHED",
              "FILLED",
            ]),
            and(
              eq(selfTradeAgentExecutionsTable.status, "CLOSED"),
              or(
                gte(selfTradeAgentExecutionsTable.filledAt, start),
                isNull(selfTradeAgentExecutionsTable.filledAt),
              ),
            ),
          ),
        ),
      );
    const pending = capacityRows.filter(
      (e) => e.status === "PENDING_TICKET" || e.status === "DISPATCHED",
    ).length;
    const filled = capacityRows.filter((e) => e.status === "FILLED").length;
    const dailyFilled = capacityRows.filter(
      (e) =>
        (e.status === "FILLED" || e.status === "CLOSED") &&
        (e.filledAt == null || e.filledAt >= start),
    ).length;
    const concurrentLimit = settings.maxConcurrentPositions;
    const dailyLimit =
      settings.baseMaxTrades +
      (settings.extensionEnabled ? settings.extensionMaxTrades : 0);
    if (
      ![
        concurrentLimit,
        settings.baseMaxTrades,
        settings.extensionMaxTrades,
        dailyLimit,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      return { ok: false, reason: "ENTRY_CAPACITY_INVALID" };
    }
    // maxConcurrentPositions=0 retains its existing explicit unlimited meaning.
    // A FILLED row without close evidence still consumes a slot, even if its
    // position snapshot is temporarily missing. Pending rows consume daily
    // headroom on every day until their broker outcome is known.
    if (concurrentLimit > 0 && pending + filled >= concurrentLimit)
      return { ok: false, reason: "AGENT_ENTRY_CAPACITY_REACHED" };
    if (pending + dailyFilled >= dailyLimit)
      return { ok: false, reason: "AGENT_DAILY_ENTRY_CAPACITY_REACHED" };

    const [execution] = await tx
      .insert(selfTradeAgentExecutionsTable)
      .values({
        agentId: agent.id,
        agentKey: agent.agentKey,
        decisionId: decision.id,
        cycleId: decision.cycleId,
        symbol: decision.symbol,
        side: input.side,
        autonomyLevel: agent.autonomyLevel,
        mode: agent.mode,
        executingUserId: input.executingUserId,
        intendedVolume: input.volume,
        slPrice: input.stopLoss,
        tpPrice: input.takeProfit,
        idempotencyKey,
        status: "PENDING_TICKET",
        managementState: {
          entryAdmissionV1: entryAuthoritySnapshot({
            agent,
            settings,
            ledger,
            decision,
            order: {
              symbol: decision.symbol,
              side: input.side,
              volume: input.volume,
              stopLoss: input.stopLoss,
              takeProfit: input.takeProfit,
            },
          }),
        },
      })
      .returning();
    if (!execution) throw new Error("ENTRY_RESERVATION_INSERT_FAILED");
    await writeSelfTradeAudit(tx, {
      agentId: agent.id,
      eventType: "ENTRY_CAPACITY_RESERVED",
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      afterState: {
        executionId: execution.id,
        decisionId: decision.id,
        executingUserId: input.executingUserId,
        pendingBefore: pending,
        filledBefore: filled,
        dailyFilledBefore: dailyFilled,
        concurrentLimit,
        dailyLimit,
      },
      reason:
        "Reserved agent entry capacity before submission; unresolved outcomes retain the reservation.",
    });
    return { ok: true, execution };
  });
}
