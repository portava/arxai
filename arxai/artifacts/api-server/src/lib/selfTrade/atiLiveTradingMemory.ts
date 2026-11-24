import { and, desc, eq, inArray, lt, lte } from "drizzle-orm";
import { arxLiveCommandsTable as commands, db, selfTradeAgentExecutionsTable as executions,
  selfTradeAgentsTable as agents, selfTradeDecisionsTable as decisions } from "@workspace/db";
import { confirmedCloseTime, isOwnedManagementCommand, readManagementMemory, resolveEntryEvidence } from "./executionLifecycle.js";
import { readAtiLiveMemoryCosts } from "./atiExecutionCosts.js";
import { atiMarketContext } from "./atiTradingContext.js";
import { atiDecisionWarnings, type AtiMemoryFilter } from "./atiTradingMemory.js";

export async function readAtiLiveMemory(ownerId: number, agentId: number, filter: AtiMemoryFilter, beforeId?: number) {
  const rows = await db.select({ execution: executions, decision: decisions }).from(executions)
    .innerJoin(agents, and(eq(agents.id, executions.agentId), eq(agents.ownerType, "USER"), eq(agents.ownerId, ownerId)))
    .leftJoin(decisions, and(eq(decisions.id, executions.decisionId), eq(decisions.agentId, executions.agentId),
      eq(decisions.symbol, executions.symbol), eq(decisions.side, executions.side), lte(decisions.createdAt, filter.asOf)))
    .where(and(
      eq(executions.agentId, agentId), eq(executions.executingUserId, ownerId), eq(executions.mode, "LIVE"),
      lte(executions.updatedAt, filter.asOf), beforeId ? lt(executions.id, beforeId) : undefined,
      filter.symbol ? eq(executions.symbol, filter.symbol) : undefined,
      filter.setup ? eq(decisions.setupType, filter.setup) : undefined,
    )).orderBy(desc(executions.id)).limit(filter.limit + 1);

  const page = rows.slice(0, filter.limit);
  const commandIds = [...new Set(page.flatMap(({ execution }) => [execution.commandId,
    readManagementMemory(execution.managementState).closeCommandId].filter((id): id is string => typeof id === "string" && id.length > 0)))];
  const owned = commandIds.length ? await db.select().from(commands)
    .where(and(eq(commands.userId, ownerId), inArray(commands.commandId, commandIds))) : [];
  const byId = new Map(owned.map((command) => [command.commandId, command]));
  const costs = await readAtiLiveMemoryCosts(ownerId, commandIds, filter.asOf);
  const episodes = page.map(({ execution, decision }) => {
    const memory = readManagementMemory(execution.managementState);
    const opening = execution.commandId ? byId.get(execution.commandId) : undefined;
    const closing = memory.closeCommandId ? byId.get(memory.closeCommandId) : undefined;
    const entry = opening ? resolveEntryEvidence(execution, opening) : null;
    const verifiedEntry = entry?.status === "FILLED" && execution.brokerTicket === entry.brokerTicket &&
      execution.fillPrice === entry.fillPrice && +entry.filledAt <= +filter.asOf ? entry : null;
    const closeTime = verifiedEntry && execution.status === "CLOSED" && closing &&
      isOwnedManagementCommand(execution, closing, "EXIT", opening)
      ? confirmedCloseTime(closing, execution.intendedVolume) : null;
    const verifiedClose = closeTime && verifiedEntry && closing && +closeTime >= +verifiedEntry.filledAt &&
      +closeTime <= +filter.asOf && execution.closedAt && +execution.closedAt === +closeTime && execution.closePrice === closing.fillPrice ? closing : null;
    const parsed = atiMarketContext.safeParse((decision?.scoreBreakdown as { atiMarketContextV1?: unknown } | undefined)?.atiMarketContextV1);
    const context = parsed.success && parsed.data.decidedAtMs <= Math.min(+filter.asOf, +(opening?.sentToMt5At ?? filter.asOf))
      ? parsed.data : null;
    return {
      source: "LIVE" as const, executionId: execution.id, symbol: execution.symbol, mode: "LIVE" as const,
      timeframe: decision?.timeframe ?? null, setup: decision?.setupType ?? null,
      recordedAt: execution.createdAt.toISOString(), availableAt: execution.updatedAt.toISOString(),
      marketContext: context,
      entry: { decisionId: decision?.id ?? null, side: execution.side, decision: decision?.outcome ?? null,
        reason: decision?.reason ?? null, warnings: atiDecisionWarnings(decision?.handshakes),
        commandId: verifiedEntry ? opening?.commandId ?? null : null,
        fill: verifiedEntry ? { at: verifiedEntry.filledAt.toISOString(), price: verifiedEntry.fillPrice,
          volume: opening?.executedVolume ?? null } : null },
      expected: { plan: decision?.thesis ?? null, trajectory: null },
      outcome: { state: execution.status, reason: execution.blockReason ?? null,
        exit: verifiedClose && closeTime ? { commandId: verifiedClose.commandId, at: closeTime.toISOString(), price: verifiedClose.fillPrice,
          volume: verifiedClose.executedVolume, source: verifiedClose.sourcePage ?? null } : null,
        recordedLedgerPnl: verifiedClose ? execution.realizedPnl : null,
        observedPath: null, excursions: null },
      executionQuality: {
        entry: verifiedEntry && opening ? costs.get(opening.commandId) ?? null : null,
        exit: verifiedClose ? costs.get(verifiedClose.commandId) ?? null : null,
      },
      evidenceGaps: [
        ...(!decision ? ["DECISION_UNAVAILABLE"] : []),
        ...(!context ? ["MARKET_CONTEXT_UNAVAILABLE"] : []),
        ...(decision?.thesis ? ["FORECAST_TRAJECTORY_UNAVAILABLE"] : []),
        ...(!verifiedEntry && (execution.status === "FILLED" || execution.status === "CLOSED") ? ["ENTRY_RECEIPT_UNVERIFIED"] : []),
        ...(!verifiedClose && execution.status === "CLOSED" ? ["EXIT_RECEIPT_UNVERIFIED"] : []),
        ...(verifiedClose ? ["EXCURSION_PATH_UNAVAILABLE"] : []),
        ...(memory.closeAccounting ? [memory.closeAccounting.reason] : []),
      ],
    };
  });
  return {
    source: "LIVE" as const, asOf: filter.asOf.toISOString(), executionAuthority: "NONE" as const,
    evidenceBasis: "CURRENT_EXECUTION_LEDGER" as const, episodes,
    nextCursor: rows.length > episodes.length ? episodes.at(-1)?.executionId ?? null : null,
  };
}
