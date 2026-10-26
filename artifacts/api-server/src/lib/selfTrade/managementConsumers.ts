// Consumers of an already signed server target. A target describes intended
// execution; it is NOT proof of the terminal account that actually executed it.
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable as agents,
  arxLiveCommandsTable as commands,
  selfTradeAgentExecutionsTable as executions,
  executionEventsTable as events,
  type ArxLiveCommand,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import {
  livePositionLedger,
  livePositionColumns as positions,
  type LivePositionRow,
} from "../positions/ledger.js";
import { hasIntactCommandSignature } from "../security/commandIntegrity.js";
import type { AuthorityTransaction } from "./entryAuthority.js";
import {
  fullVolumeEvidence,
  ownedEntryBinding,
  sameBrokerAccount,
  readManagementMemory,
} from "./executionLifecycle.js";
import {
  MANAGEMENT_TARGET_SOURCE,
  ManagementTargetError,
  boundManagementTransportSymbol,
  managementTargetFromCommand,
  resolveManagementTarget,
  type ManagementTarget,
} from "./managementTarget.js";

const refuse = (reason: string): never => {
  throw new ManagementTargetError(reason);
};

function signedTarget(command: ArxLiveCommand): ManagementTarget {
  const target = managementTargetFromCommand(command);
  if (!target || !hasIntactCommandSignature(command))
    return refuse("MANAGEMENT_SIGNATURE_UNVERIFIED");
  boundManagementTransportSymbol(command);
  if (
    command.source !== MANAGEMENT_TARGET_SOURCE ||
    command.sourcePage !== MANAGEMENT_TARGET_SOURCE ||
    command.actorType !== "SELF_TRADE_AGENT" ||
    command.actorId !== target.userId ||
    command.selfTradeAgentId !== target.agentId ||
    command.selfTradeDecisionId !== target.decisionId
  )
    return refuse("MANAGEMENT_COMMAND_CHANGED");
  return target;
}

/** Exact live facts for the existing governor; no risk rule is duplicated here. */
export async function readBoundManagementRiskPosition(command: ArxLiveCommand) {
  const target = signedTarget(command);
  const facts = await resolveManagementTarget(command.userId, target);
  if (
    !isDeepStrictEqual(target, facts.target) ||
    command.commandType !== "MODIFY_LIVE_SLTP"
  )
    return refuse("MANAGEMENT_RISK_TARGET_CHANGED");
  return {
    entryPrice: facts.position.entryPrice,
    stopLoss: facts.position.stopLoss,
  };
}

/** Keep every explicit claim, including conflicting aliases, rather than silently preferring one. */
export function reportedManagementIdentity(
  ...inputs: Array<Record<string, unknown> | null | undefined>
) {
  const claims: Array<{ field: string; value: unknown }> = [];
  const aliases: Record<string, string[]> = {
    accountLogin: ["accountLogin", "accountNumber"],
    serverName: ["serverName", "accountServer", "server"],
    symbol: ["resolvedBrokerSymbol"],
    positionTicket: ["mt5PositionTicket", "positionTicket"],
  };
  for (const input of inputs) {
    if (!input) continue;
    const nested = input.executionIdentity;
    const sources = [
      input,
      ...(nested && typeof nested === "object" && !Array.isArray(nested)
        ? [nested as Record<string, unknown>]
        : []),
    ];
    for (const source of sources)
      for (const [field, names] of Object.entries(aliases)) {
        for (const name of names)
          if (
            source[name] != null &&
            source[name] !== "" &&
            !(
              field === "positionTicket" &&
              (source[name] === 0 || source[name] === "0")
            )
          )
            claims.push({ field, value: source[name] });
      }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const symbol = (nested as Record<string, unknown>).symbol;
      if (symbol != null && symbol !== "")
        claims.push({ field: "symbol", value: symbol });
    }
  }
  return claims;
}

/** Immutable row identity. Current bridge labels are deliberately not consulted. */
export function managementPositionScope(target: ManagementTarget) {
  return and(
    eq(positions.id, target.positionRowId),
    eq(positions.userId, target.userId),
    eq(positions.bridgeConnectionId, target.bridgeConnectionId),
    eq(positions.accountLogin, target.accountLogin),
    eq(positions.brokerServer, target.legacyBrokerCompany),
    eq(positions.brokerTicket, target.brokerTicket),
    eq(positions.sourceCommandId, target.entryCommandId),
    eq(positions.symbol, target.symbol),
    eq(positions.side, target.side),
  );
}

function assertReceipt(
  target: ManagementTarget,
  command: ArxLiveCommand,
  evidence: Record<string, unknown>,
) {
  if (
    evidence.applied !== true ||
    evidence.finalStatus !== "LIVE_FILLED" ||
    evidence.reportingBridgeConnectionId !== target.bridgeConnectionId ||
    evidence.executedVolume !== command.executedVolume
  )
    refuse("MANAGEMENT_RESULT_EVIDENCE_UNVERIFIED");
  const expected: Record<string, string> = {
    accountLogin: target.accountLogin,
    serverName: target.observedServerName,
    symbol: target.symbol,
    positionTicket: target.brokerTicket,
  };
  const claims = evidence.reportedExecutionIdentity;
  if (claims != null) {
    if (!Array.isArray(claims)) refuse("MANAGEMENT_RESULT_IDENTITY_MISMATCH");
    for (const claim of claims as Array<{ field?: unknown; value?: unknown }>) {
      if (
        !claim ||
        typeof claim.field !== "string" ||
        !(claim.field in expected) ||
        (typeof claim.value !== "string" &&
          !(
            typeof claim.value === "number" && Number.isSafeInteger(claim.value)
          )) ||
        String(claim.value) !== expected[claim.field]
      )
        refuse("MANAGEMENT_RESULT_IDENTITY_MISMATCH");
    }
  }
  // No claims means the legacy EA reported no terminal identity. It is never
  // replaced with the current connection's identity or described as certified.
}

/**
 * Full-close ledger application only. Receipt recording happens elsewhere.
 * Agent lock serializes accounting holds with admission (no bridge lock):
 * agent -> execution ->
 * entry -> position -> management command. No bridge is acquired, no network.
 */
export async function withBoundManagementClose<T>(
  expected: ArxLiveCommand,
  apply: (
    tx: AuthorityTransaction,
    target: ManagementTarget,
    position: LivePositionRow,
    facts: {
      execution: SelfTradeAgentExecution;
      entry: ArxLiveCommand;
      command: ArxLiveCommand;
    },
  ) => Promise<T>,
  database: typeof db = db,
): Promise<T> {
  const target = signedTarget(expected);
  if (
    expected.commandType !== "CLOSE_LIVE_POSITION" ||
    target.action !== "EXIT"
  )
    return refuse("MANAGEMENT_CLOSE_TARGET_REQUIRED");
  return database.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, target.agentId))
      .for("update");
    const owner =
      agent?.ownerType === "USER"
        ? agent.ownerId
        : agent?.ownerType === "OPERATOR_FLEET" && agent.ownerId == null
          ? agent.createdByUserId
          : null;
    if (owner !== target.userId)
      return refuse("MANAGEMENT_RESULT_OWNER_CHANGED");
    const [execution] = await tx
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.id, target.executionId),
          eq(executions.executingUserId, target.userId),
        ),
      )
      .for("update");
    const [entry] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.commandId, target.entryCommandId),
          eq(commands.userId, target.userId),
        ),
      )
      .for("update");
    const [position] = await livePositionLedger.readForUpdate(
      { where: managementPositionScope(target) },
      tx,
    );
    const [command] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.commandId, expected.commandId),
          eq(commands.userId, target.userId),
        ),
      )
      .for("update");
    if (
      !command ||
      !isDeepStrictEqual(signedTarget(command), target) ||
      command.status !== "LIVE_FILLED" ||
      !fullVolumeEvidence(command, target.volume)
    )
      return refuse("MANAGEMENT_FULL_CLOSE_UNVERIFIED");
    if (
      !execution ||
      !entry ||
      !ownedEntryBinding(execution, entry) ||
      execution.agentId !== target.agentId ||
      execution.mode !== "LIVE" ||
      execution.decisionId !== target.decisionId ||
      execution.brokerTicket !== target.brokerTicket ||
      execution.intendedVolume !== target.volume ||
      readManagementMemory(execution.managementState).closeCommandId !==
        command.commandId ||
      entry.status !== "LIVE_FILLED" ||
      entry.brokerTicket !== target.brokerTicket ||
      entry.symbol !== target.symbol ||
      entry.side !== target.side ||
      !sameBrokerAccount(entry, command) ||
      !fullVolumeEvidence(entry, target.volume) ||
      !position ||
      position.volume !== target.volume
    )
      return refuse("MANAGEMENT_RESULT_TARGET_CHANGED");
    const applied = await tx
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.commandId, command.id),
          eq(events.eventType, "RESULT_LIVE_FILLED"),
        ),
      );
    if (applied.length !== 1)
      return refuse("MANAGEMENT_RESULT_EVIDENCE_UNVERIFIED");
    assertReceipt(
      target,
      command,
      applied[0]!.payload as Record<string, unknown>,
    );
    // This same transaction may close the position or settle lifecycle. Publish
    // the accounting hold first under the admission agent lock; neither can
    // create an uncounted-loss window for a later admission/final claim.
    const closeAccounting = {
      status: "UNVERIFIED" as const,
      reason: "HISTORICAL_ACCOUNTING_EVIDENCE_MISSING" as const,
      entryCommandId: entry.commandId,
      symbol: entry.symbol,
      userId: target.userId,
      agentId: target.agentId,
      accountLogin: target.accountLogin,
      bridgeConnectionId: target.bridgeConnectionId,
      observedServerName: target.observedServerName,
    };
    const memory = {
      ...readManagementMemory(execution.managementState),
      closeAccounting,
    };
    if (!isDeepStrictEqual(memory, execution.managementState)) {
      await tx
        .update(executions)
        .set({ managementState: memory, updatedAt: new Date() })
        .where(eq(executions.id, execution.id));
      execution.managementState = memory;
    }
    return apply(tx, target, position, { execution, entry, command });
  });
}

/** Same exact identity in the write predicate, even while holding the row lock. */
export function managementFullCloseScope(target: ManagementTarget) {
  return and(
    managementPositionScope(target),
    eq(positions.volume, target.volume),
    isNull(positions.closedAt),
  );
}
