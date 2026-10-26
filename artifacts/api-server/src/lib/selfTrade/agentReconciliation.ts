// Broker-evidence reconciliation for self-trading. Never submits a command.
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  arxLiveCommandsTable,
} from "@workspace/db";
import {
  computeRealizedPnlUsd,
  isRealizedPnlIngestible,
} from "../live/realizedPnl.js";
import {
  resolveContractSize,
  resolveQuoteToAccountFx,
} from "../mt5/contractSize.js";
import { getAccountCurrency } from "../live/accountCurrency.js";
import {
  resolveEntryEvidence,
  isOwnedManagementCommand,
  confirmedCloseTime,
  readManagementMemory,
} from "./executionLifecycle.js";

import { logger } from "../logger.js";
import {
  isAgentManagementCommand,
  ManagementTargetError,
} from "./managementTarget.js";
import { withBoundManagementClose } from "./managementConsumers.js";

export interface ReconcileResult {
  filled: number;
  rejected: number;
  closed: number;
  expired: number;
}

/**
 * Reconcile PENDING_TICKET / DISPATCHED / FILLED executions against their REAL arx_live_commands
 * outcomes. dispatch ≠ fill: a DISPATCHED row only becomes FILLED on a real
 * LIVE_FILLED + brokerTicket. Close P/L is computed ONLY from genuine open +
 * close fill prices (never fabricated).
 */
export async function reconcileAgentExecutions(
  agentId: number,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    filled: 0,
    rejected: 0,
    closed: 0,
    expired: 0,
  };

  const active = await db
    .select()
    .from(selfTradeAgentExecutionsTable)
    .where(
      and(
        eq(selfTradeAgentExecutionsTable.agentId, agentId),
        inArray(selfTradeAgentExecutionsTable.status, [
          "PENDING_TICKET",
          "DISPATCHED",
          "FILLED",
        ]),
      ),
    );

  const commandIds = [
    ...new Set(
      active.flatMap((execution) => {
        const closeId = readManagementMemory(
          execution.managementState,
        ).closeCommandId;
        return [execution.commandId, closeId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
      }),
    ),
  ];
  const commandRows =
    commandIds.length === 0
      ? []
      : await db
          .select()
          .from(arxLiveCommandsTable)
          .where(inArray(arxLiveCommandsTable.commandId, commandIds));
  const byCommand = new Map(
    commandRows.map((command) => [command.commandId, command]),
  );

  for (const e of active) {
    // A prepared draft can be confirmed by a person between cycles. It follows
    // exactly the same evidence rules as a command dispatched autonomously.
    if (
      (e.status === "PENDING_TICKET" || e.status === "DISPATCHED") &&
      e.commandId
    ) {
      const cmd = byCommand.get(e.commandId);
      if (!cmd) continue;
      const next = resolveEntryEvidence(e, cmd);
      if (!next || next.status === e.status) continue;
      const updated = await db
        .update(selfTradeAgentExecutionsTable)
        .set({ ...next, updatedAt: new Date() })
        .where(
          and(
            eq(selfTradeAgentExecutionsTable.id, e.id),
            eq(selfTradeAgentExecutionsTable.status, e.status),
          ),
        )
        .returning({ id: selfTradeAgentExecutionsTable.id });
      // Concurrent reconciliation may observe the same event; only the writer
      // that advanced the state counts it. Use broker event time, never poll time.
      if (updated.length === 0) continue;
      if (next.status === "FILLED") result.filled++;
      else if (next.status === "REJECTED") result.rejected++;
      else if (next.status === "EXPIRED") result.expired++;
      continue;
    }

    // ── Resolve close for FILLED rows that issued a close command ──────────
    if (e.status === "FILLED") {
      const mgmt = readManagementMemory(e.managementState);
      if (!mgmt.closeCommandId) continue;
      const closeCmd = byCommand.get(mgmt.closeCommandId);
      if (!closeCmd) continue;
      const entryCommand = e.commandId ? byCommand.get(e.commandId) : undefined;
      if (!isOwnedManagementCommand(e, closeCmd, "EXIT", entryCommand))
        continue;
      const closedAt = confirmedCloseTime(closeCmd, e.intendedVolume);
      if (!closedAt) continue;

      if (isAgentManagementCommand(closeCmd)) {
        // Account identity and valuation are different evidence. The current
        // per-user spec/currency can belong to a subsequently selected account.
        // No immutable historical valuation envelope is persisted today, so a
        // proven exact close may settle lifecycle but cannot certify P/L.
        try {
          result.closed += await withBoundManagementClose(
            closeCmd,
            async (tx, _target, _position, facts) => {
              const brokerClosedAt = confirmedCloseTime(
                facts.command,
                facts.execution.intendedVolume,
              );
              if (!brokerClosedAt) return 0;
              const closed = await tx
                .update(selfTradeAgentExecutionsTable)
                .set({
                  status: "CLOSED",
                  closePrice: facts.command.fillPrice,
                  realizedPnl: null,
                  closedAt: brokerClosedAt,
                  updatedAt: new Date(),
                  managementState: facts.execution.managementState,
                })
                .where(
                  and(
                    eq(selfTradeAgentExecutionsTable.id, facts.execution.id),
                    eq(selfTradeAgentExecutionsTable.status, "FILLED"),
                  ),
                )
                .returning({ id: selfTradeAgentExecutionsTable.id });
              return closed.length;
            },
          );
        } catch (error) {
          logger.warn(
            {
              commandId: closeCmd.commandId,
              reason:
                error instanceof ManagementTargetError
                  ? error.reason
                  : "MANAGEMENT_SETTLEMENT_READ_FAILED",
            },
            "Self-trade close settlement held",
          );
        }
        continue;
      }

      // P0-2 — size the close from broker truth for THIS user's symbol spec.
      // The close command carries the authoritative dispatching user.
      const pnlUserId = closeCmd.userId ?? e.executingUserId;
      const sizing =
        pnlUserId != null
          ? await resolveContractSize(pnlUserId, entryCommand!.symbol)
          : ({
              contractSize: null,
              profitCurrency: null,
              source: null,
              reason: null,
            } as const);
      const accountCurrency =
        pnlUserId != null ? await getAccountCurrency(pnlUserId) : "USD";
      const fx = resolveQuoteToAccountFx({
        symbol: entryCommand!.symbol,
        profitCurrency: sizing.profitCurrency,
        accountCurrency,
        closePrice: closeCmd.fillPrice ?? 0,
      });
      const pnl = computeRealizedPnlUsd({
        side: e.side as "BUY" | "SELL",
        requestedVolume: e.intendedVolume,
        openFillPrice: e.fillPrice,
        closeFillPrice: closeCmd.fillPrice,
        contractSize: sizing.contractSize,
        quoteToAccountFx: fx.factor,
      });
      const closed = await db
        .update(selfTradeAgentExecutionsTable)
        .set({
          status: "CLOSED",
          closePrice: closeCmd.fillPrice ?? null,
          realizedPnl: isRealizedPnlIngestible(pnl) ? pnl.realizedPlUsd : null,
          closedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(selfTradeAgentExecutionsTable.id, e.id),
            eq(selfTradeAgentExecutionsTable.status, "FILLED"),
          ),
        )
        .returning({ id: selfTradeAgentExecutionsTable.id });
      result.closed += closed.length;
    }
  }

  return result;
}
