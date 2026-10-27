// Authority lasts until the final dispatch claim, not merely until admission.
// This layer can only refuse; the Trade Engine still owns every live gate.
import {
  hasUnresolvedAgentAccounting,
  ENTRY_ACCOUNTING_UNRESOLVED,
} from "./accountingHold.js";
import {
  lockKillSwitchesShared,
  readKillSwitchVerdict,
} from "./killSwitchScope.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
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
  type ArxLiveCommand,
} from "@workspace/db";

export type AuthorityTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
type SnapshotInputs = {
  agent: SelfTradeAgent;
  settings: SelfTradeAgentSettings;
  ledger: SelfTradeAgentLedger;
  decision: SelfTradeDecision;
  order: {
    symbol: string;
    side: string;
    volume: number;
    stopLoss: number | null;
    takeProfit: number | null;
  };
};
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** JSON dates match the durable JSONB representation; no mutable object aliases. */
export function entryAuthoritySnapshot(input: SnapshotInputs): unknown {
  return json({ version: 1, ...input });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export interface AgentAdmissionEnvelope {
  version: 1;
  executionId: number;
  snapshotHash: string;
}

export class AgentEntryAuthorityError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}
/** Refusal when a self-trade kill switch covers the entry at draft/confirm/claim. */
export const ENTRY_KILL_SWITCH_ENGAGED = "ENTRY_KILL_SWITCH_ENGAGED" as const;
const refuse = (reason: string): never => {
  throw new AgentEntryAuthorityError(reason);
};
const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function admissionEnvelope(
  execution: SelfTradeAgentExecution,
): AgentAdmissionEnvelope {
  const snapshot = record(execution.managementState)?.entryAdmissionV1;
  if (record(snapshot)?.version !== 1) return refuse("ENTRY_AUTHORITY_MISSING");
  return {
    version: 1,
    executionId: execution.id,
    snapshotHash: createHash("sha256")
      .update(canonical(snapshot))
      .digest("hex"),
  };
}

export interface EntryAuthorityRequest {
  userId: number;
  agentId: number;
  decisionId: number;
  executionId: number;
  symbol: string;
  side: string;
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  symbolBinding: unknown;
}

/** Exact server-created canonical/native mapping, never suffix normalization. */
export function entrySymbolMatches(
  requested: string,
  broker: string,
  binding: unknown,
): boolean {
  if (binding == null) return requested === broker;
  const b = record(binding);
  return b?.requestedSymbol === requested && b?.brokerSymbol === broker;
}

/**
 * Shared writer order: agent → settings → ledger → decision → execution.
 * Callbacks may lock/transition the command next; no network belongs here.
 */
export async function withEntryAuthority<T>(
  request: EntryAuthorityRequest,
  operation: (
    tx: AuthorityTransaction,
    execution: SelfTradeAgentExecution,
    envelope: AgentAdmissionEnvelope,
  ) => Promise<T>,
  database: typeof db = db,
  clock: () => Date = () => new Date(),
): Promise<T> {
  if (
    ![
      request.userId,
      request.agentId,
      request.decisionId,
      request.executionId,
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    refuse("ENTRY_AUTHORITY_LINK_INVALID");
  return database.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, request.agentId))
      .for("update");
    if (!agent) return refuse("ENTRY_AUTHORITY_AGENT_MISSING");
    const owner =
      agent.ownerType === "USER"
        ? agent.ownerId
        : agent.ownerType === "OPERATOR_FLEET" && agent.ownerId == null
          ? agent.createdByUserId
          : null;
    if (owner !== request.userId) return refuse("ENTRY_OWNER_CHANGED");
    if (
      agent.status !== "ACTIVE" ||
      agent.mode !== "LIVE" ||
      !Number.isInteger(agent.autonomyLevel) ||
      agent.autonomyLevel < 1 ||
      agent.autonomyLevel > 4
    )
      return refuse("ENTRY_AGENT_AUTHORITY_CHANGED");
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
      .where(eq(selfTradeDecisionsTable.id, request.decisionId))
      .for("update");
    const [execution] = await tx
      .select()
      .from(selfTradeAgentExecutionsTable)
      .where(eq(selfTradeAgentExecutionsTable.id, request.executionId))
      .for("update");
    if (!settings || !ledger || !decision || !execution)
      return refuse("ENTRY_AUTHORITY_CONTEXT_MISSING");
    if (
      execution.agentId !== agent.id ||
      execution.decisionId !== decision.id ||
      execution.executingUserId !== request.userId ||
      execution.agentKey !== agent.agentKey ||
      decision.agentId !== agent.id ||
      decision.agentKey !== agent.agentKey ||
      execution.idempotencyKey !== `decision:${decision.id}` ||
      execution.status !== "PENDING_TICKET" ||
      execution.mode !== "LIVE" ||
      execution.autonomyLevel !== agent.autonomyLevel ||
      execution.side !== request.side ||
      decision.side !== request.side ||
      execution.symbol !== decision.symbol ||
      !entrySymbolMatches(
        decision.symbol,
        request.symbol,
        request.symbolBinding,
      ) ||
      execution.intendedVolume !== request.volume ||
      execution.slPrice !== request.stopLoss ||
      execution.tpPrice !== request.takeProfit ||
      !["APPROVED", "APPROVED_REDUCED", "PREPARE_ONLY"].includes(
        decision.outcome,
      )
    )
      return refuse("ENTRY_AUTHORITY_LINK_MISMATCH");
    const now = clock(); // after lock acquisition: a queued request cannot evade expiry.
    if (
      !Number.isFinite(now.getTime()) ||
      (decision.setupExpiresAt != null &&
        (!Number.isFinite(decision.setupExpiresAt.getTime()) ||
          decision.setupExpiresAt <= now))
    )
      return refuse("ENTRY_SETUP_EXPIRED");
    const envelope = admissionEnvelope(execution);
    if (
      !isDeepStrictEqual(
        record(execution.managementState)?.entryAdmissionV1,
        entryAuthoritySnapshot({
          agent,
          settings,
          ledger,
          decision,
          order: {
            symbol: decision.symbol,
            side: request.side,
            volume: request.volume,
            stopLoss: request.stopLoss,
            takeProfit: request.takeProfit,
          },
        }),
      )
    )
      return refuse("ENTRY_AUTHORITY_CHANGED");
    if (
      !Number.isFinite(ledger.availableFunds) ||
      ledger.availableFunds <= 0 ||
      !Number.isFinite(ledger.allocatedFunds) ||
      ledger.allocatedFunds <= 0
    )
      return refuse("ENTRY_NOT_FUNDED");
    if (await hasUnresolvedAgentAccounting(tx, agent.id))
      return refuse(ENTRY_ACCOUNTING_UNRESOLVED);
    // Emergency stop at the linearization point. The shared advisory lock
    // serializes this read against every kill-switch write (exclusive side in
    // service.toggleKillSwitch): an engage that commits first is seen here; a
    // claim that commits first is a completed hand-off. A read error throws,
    // rolls the transaction back and is mapped to a refusal by the caller.
    await lockKillSwitchesShared(tx);
    const kill = await readKillSwitchVerdict(
      {
        agentKey: agent.agentKey,
        symbol: decision.symbol,
        symbols: [request.symbol],
        strategy: decision.setupType ?? null,
      },
      tx,
    );
    if (kill.killed) return refuse(ENTRY_KILL_SWITCH_ENGAGED);
    return operation(tx, execution, envelope);
  });
}

export function isAgentEntryCommand(
  row: Pick<
    ArxLiveCommand,
    | "selfTradeAgentId"
    | "selfTradeDecisionId"
    | "actorType"
    | "payload"
    | "commandType"
    | "sourcePage"
  >,
): boolean {
  if (
    !["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"].includes(
      row.commandType,
    )
  )
    return false;
  return (
    row.selfTradeAgentId != null ||
    row.selfTradeDecisionId != null ||
    row.actorType === "SELF_TRADE_AGENT" ||
    record(row.payload)?.agentAdmissionV1 != null ||
    record(row.payload)?.agentOwnership != null ||
    row.sourcePage === "INSTANT_SELF_TRADE"
  );
}

export function authorityRequestForCommand(
  row: ArxLiveCommand,
): EntryAuthorityRequest {
  const payload = record(row.payload);
  const envelope = record(payload?.agentAdmissionV1);
  const ownership = record(payload?.agentOwnership);
  if (
    envelope?.version !== 1 ||
    typeof envelope.snapshotHash !== "string" ||
    ownership?.selfTradeAgentId !== row.selfTradeAgentId ||
    ownership?.selfTradeDecisionId !== row.selfTradeDecisionId ||
    row.actorType !== "SELF_TRADE_AGENT" ||
    row.actorId !== row.userId
  )
    return refuse("ENTRY_AUTHORITY_ENVELOPE_INVALID");
  return {
    userId: row.userId,
    agentId: row.selfTradeAgentId!,
    decisionId: row.selfTradeDecisionId!,
    executionId: envelope.executionId as number,
    symbol: row.symbol,
    side: row.side,
    volume: Number(row.requestedVolume),
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    symbolBinding: payload?.selfTradeSymbolBinding,
  };
}

/** Compare all command fields after locking, including integrity and attribution. */
export function assertUnchangedAuthorityCommand(
  expected: ArxLiveCommand,
  current: ArxLiveCommand,
  execution: SelfTradeAgentExecution,
  envelope: AgentAdmissionEnvelope,
): void {
  if (
    execution.commandId !== current.commandId ||
    !isDeepStrictEqual(record(current.payload)?.agentAdmissionV1, envelope) ||
    !isDeepStrictEqual(current, expected)
  )
    refuse("ENTRY_AUTHORITY_COMMAND_CHANGED");
}

/** Draft creation and reservation linkage commit or roll back together. */
export function createAgentEntryDraft(
  request: EntryAuthorityRequest,
  create: (
    tx: AuthorityTransaction,
    envelope: AgentAdmissionEnvelope,
  ) => Promise<ArxLiveCommand>,
  database: typeof db = db,
  clock?: () => Date,
): Promise<ArxLiveCommand> {
  return withEntryAuthority(
    request,
    async (tx, execution, envelope) => {
      if (execution.commandId != null) return refuse("ENTRY_ALREADY_LINKED");
      const command = await create(tx, envelope);
      await tx
        .update(selfTradeAgentExecutionsTable)
        .set({ commandId: command.commandId, updatedAt: new Date() })
        .where(eq(selfTradeAgentExecutionsTable.id, execution.id));
      return command;
    },
    database,
    clock,
  );
}
