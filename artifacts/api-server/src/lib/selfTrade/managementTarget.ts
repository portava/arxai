// Exact SERVER management identity. legacyBrokerCompany is the existing
// brokerServer column's company label, NOT an MT5 server or terminal session.
// Upgraded EAs additionally preflight current identity; terminal-session
// atomicity and broker execution identity remain unverified.
import { supportsManagementTarget } from "../mt5/managementTargetProtocol.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable as commands,
  selfTradeAgentExecutionsTable as executions,
  type ArxLiveCommand,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import {
  livePositionLedger,
  livePositionColumns as positions,
  type LivePositionRow,
} from "../positions/ledger.js";
import {
  getConnection,
  lockConnection,
  type BrokerConnection,
} from "../brokerHub/connections.js";
import {
  ownedEntryBinding,
  fullVolumeEvidence,
  readManagementMemory,
  sameBrokerAccount,
} from "./executionLifecycle.js";
import type { AuthorityTransaction } from "./entryAuthority.js";
import {
  evaluatePositionObservation,
  evaluateProtectiveObservation,
  parseObservationTime,
} from "./freshFacts.js";
import { doesNotLoosenStop } from "@workspace/domain/self-trade";

export const MANAGEMENT_TARGET_SOURCE = "INSTANT_SELF_TRADE_MANAGEMENT";
export class ManagementTargetError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ManagementTargetError";
  }
}
const refuse = (reason: string): never => {
  throw new ManagementTargetError(reason);
};
export interface ManagementReference {
  executionId: number;
  positionRowId: number;
  claimId: string;
}
export interface ManagementTarget extends ManagementReference {
  version: 1;
  userId: number;
  agentId: number;
  decisionId: number;
  entryCommandId: string;
  bridgeConnectionId: number;
  bridgeOwnerUserId: number;
  observedServerName: string;
  accountLogin: string;
  legacyBrokerCompany: string;
  brokerTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  action: "EXIT" | "MOVE_TO_BE" | "TIGHTEN_SL";
  nextStopLoss: number | null;
  currentStopLoss: number | null;
  currentTakeProfit: number | null;
}
type Reader = Pick<typeof db, "select" | "selectDistinct">;
const positiveId = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0;
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
function validReference(value: ManagementReference): boolean {
  return (
    !!value &&
    positiveId(value.executionId) &&
    positiveId(value.positionRowId) &&
    nonempty(value.claimId)
  );
}

/** Reconstruct from durable execution/entry/position facts, never from source tags. */
export function buildManagementTarget(
  userId: number,
  reference: ManagementReference,
  execution: SelfTradeAgentExecution | undefined,
  entry: ArxLiveCommand | undefined,
  position: LivePositionRow | undefined,
  bridge: BrokerConnection | null,
): ManagementTarget {
  if (
    !validReference(reference) ||
    !execution ||
    execution.id !== reference.executionId ||
    execution.executingUserId !== userId ||
    !positiveId(execution.decisionId) ||
    execution.status !== "FILLED" ||
    !entry ||
    !ownedEntryBinding(execution, entry) ||
    entry.status !== "LIVE_FILLED" ||
    !sameBrokerAccount(entry, entry) ||
    !fullVolumeEvidence(entry, execution.intendedVolume) ||
    !nonempty(execution.brokerTicket) ||
    entry.brokerTicket !== execution.brokerTicket
  )
    return refuse("MANAGEMENT_ENTRY_IDENTITY_UNVERIFIED");
  if (
    !position ||
    position.id !== reference.positionRowId ||
    position.userId !== userId ||
    position.closedAt != null ||
    !sameBrokerAccount(entry, position) ||
    position.sourceCommandId !== entry.commandId ||
    position.brokerTicket !== execution.brokerTicket ||
    position.symbol !== entry.symbol ||
    position.side !== execution.side ||
    position.volume !== execution.intendedVolume
  )
    return refuse("MANAGEMENT_POSITION_IDENTITY_CHANGED");
  if (
    !bridge ||
    bridge.id !== entry.bridgeConnectionId ||
    !positiveId(bridge.userId) ||
    bridge.accountNumber !== entry.accountLogin ||
    bridge.brokerName !== entry.brokerServer ||
    !nonempty(bridge.serverName) ||
    bridge.tokenRevokedAt != null ||
    bridge.status === "revoked" ||
    !bridge.hasBridgeToken
  )
    return refuse("MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
  const pending = readManagementMemory(
    execution.managementState,
  ).pendingManagement;
  if (
    !pending ||
    pending.claimId !== reference.claimId ||
    !["EXIT", "MOVE_TO_BE", "TIGHTEN_SL"].includes(pending.action) ||
    (pending.action !== "EXIT" &&
      !(
        typeof pending.stopLoss === "number" &&
        Number.isFinite(pending.stopLoss) &&
        pending.stopLoss > 0
      ))
  )
    return refuse("MANAGEMENT_CLAIM_MISMATCH");
  return {
    version: 1,
    ...reference,
    userId,
    agentId: execution.agentId,
    decisionId: execution.decisionId!,
    entryCommandId: entry.commandId,
    bridgeConnectionId: entry.bridgeConnectionId!,
    bridgeOwnerUserId: bridge.userId!,
    observedServerName: bridge.serverName!,
    accountLogin: entry.accountLogin!,
    legacyBrokerCompany: entry.brokerServer!,
    brokerTicket: execution.brokerTicket,
    symbol: entry.symbol,
    side: execution.side as "BUY" | "SELL",
    volume: position.volume,
    action: pending.action,
    nextStopLoss: pending.action === "EXIT" ? null : pending.stopLoss,
    currentStopLoss: position.stopLoss,
    currentTakeProfit: position.takeProfit,
  };
}

async function readFacts(
  userId: number,
  reference: ManagementReference,
  reader: Reader,
  lock = false,
) {
  if (!validReference(reference)) return refuse("MANAGEMENT_TARGET_REQUIRED");
  const eQuery = reader
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.id, reference.executionId),
        eq(executions.executingUserId, userId),
      ),
    );
  const [execution] = await (lock ? eQuery.for("update") : eQuery);
  const cQuery = reader
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.commandId, execution?.commandId ?? ""),
        eq(commands.userId, userId),
      ),
    );
  const [entry] = await (lock ? cQuery.for("update") : cQuery);
  const [position] = await (lock
    ? livePositionLedger.readForUpdate
    : livePositionLedger.read)(
    {
      where: and(
        eq(positions.id, reference.positionRowId),
        eq(positions.userId, userId),
      ),
    },
    reader,
  );
  const bridge = entry?.bridgeConnectionId
    ? await getConnection(entry.bridgeConnectionId, reader)
    : null;
  return {
    execution,
    entry,
    position,
    target: buildManagementTarget(
      userId,
      reference,
      execution,
      entry,
      position,
      bridge,
    ),
  };
}

export async function resolveManagementTarget(
  userId: number,
  reference: ManagementReference,
  reader: Reader = db,
) {
  return readFacts(userId, reference, reader);
}

export function assertManagementBridge(
  target: ManagementTarget,
  bridge: BrokerConnection | null,
): void {
  if (
    !bridge ||
    bridge.id !== target.bridgeConnectionId ||
    bridge.accountNumber !== target.accountLogin ||
    bridge.brokerName !== target.legacyBrokerCompany ||
    bridge.userId !== target.bridgeOwnerUserId ||
    bridge.serverName !== target.observedServerName ||
    bridge.tokenRevokedAt != null ||
    bridge.status === "revoked" ||
    !bridge.hasBridgeToken
  )
    refuse("MANAGEMENT_BRIDGE_IDENTITY_CHANGED");
}

export function managementTargetFromCommand(
  row: Pick<ArxLiveCommand, "payload">,
): ManagementTarget | null {
  const value = (row.payload as Record<string, unknown> | null)
    ?.managementTargetV1;
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return null;
  const target = value as ManagementTarget;
  return target.version === 1 &&
    validReference(target) &&
    positiveId(target.userId) &&
    positiveId(target.bridgeConnectionId) &&
    positiveId(target.bridgeOwnerUserId) &&
    nonempty(target.observedServerName) &&
    positiveId(target.agentId) &&
    positiveId(target.decisionId) &&
    nonempty(target.entryCommandId) &&
    nonempty(target.accountLogin) &&
    nonempty(target.legacyBrokerCompany) &&
    nonempty(target.brokerTicket) &&
    nonempty(target.symbol)
    ? target
    : null;
}

export function isAgentManagementCommand(
  row: Pick<
    ArxLiveCommand,
    | "commandType"
    | "payload"
    | "sourcePage"
    | "source"
    | "selfTradeAgentId"
    | "selfTradeDecisionId"
    | "actorType"
  >,
): boolean {
  if (
    row.commandType !== "CLOSE_LIVE_POSITION" &&
    row.commandType !== "MODIFY_LIVE_SLTP"
  )
    return false;
  const payload = row.payload as Record<string, unknown> | null;
  return (
    row.source === MANAGEMENT_TARGET_SOURCE ||
    row.sourcePage === MANAGEMENT_TARGET_SOURCE ||
    row.sourcePage === "INSTANT_MODIFY_SELF_TRADE" ||
    row.actorType === "SELF_TRADE_AGENT" ||
    row.selfTradeAgentId != null ||
    row.selfTradeDecisionId != null ||
    payload?.managementTargetV1 != null ||
    payload?.agentOwnership != null ||
    payload?.selfTradeSymbolBinding != null
  );
}

export function assertManagementGeometry(
  target: ManagementTarget,
  input: {
    userId: number;
    commandType: string;
    symbol: string;
    side: string;
    volume: number;
    brokerTicket: string;
    newStopLoss?: number | null;
    newTakeProfit?: number | null;
  },
): void {
  if (
    input.userId !== target.userId ||
    input.commandType !==
      (target.action === "EXIT" ? "CLOSE_LIVE_POSITION" : "MODIFY_LIVE_SLTP") ||
    input.brokerTicket !== target.brokerTicket ||
    input.symbol !== target.symbol ||
    input.side !== target.side ||
    input.volume !== target.volume ||
    (input.newStopLoss ?? null) !== target.nextStopLoss ||
    (input.newTakeProfit ?? null) !==
      (target.action === "EXIT" ? null : target.currentTakeProfit)
  )
    refuse("MANAGEMENT_ORDER_TARGET_MISMATCH");
}

async function withTarget<T>(
  target: ManagementTarget,
  run: (
    tx: AuthorityTransaction,
    facts: Awaited<ReturnType<typeof readFacts>>,
    bridge: BrokerConnection,
  ) => Promise<T>,
  database: typeof db,
) {
  // Lock order: bridge -> execution -> attributed entry -> exact position -> ops
  // command. Existing entry authority never locks a bridge; position/result
  // ingestion commits each statement separately. No network under these locks.
  return database.transaction(async (tx) => {
    const bridge = await lockConnection(target.bridgeConnectionId, tx);
    assertManagementBridge(target, bridge);
    const facts = await readFacts(target.userId, target, tx, true);
    if (!isDeepStrictEqual(target, facts.target))
      refuse("MANAGEMENT_TARGET_CHANGED");
    return run(tx, facts, bridge!);
  });
}

/** Draft and management-command linkage are atomic; unknown outcomes stay held. */
export function createManagementDraft(
  target: ManagementTarget,
  create: (
    tx: AuthorityTransaction,
    facts: Awaited<ReturnType<typeof readFacts>>,
    bridge: BrokerConnection,
  ) => Promise<ArxLiveCommand>,
  database: typeof db = db,
) {
  return withTarget(
    target,
    async (tx, facts, bridge) => {
      const memory = readManagementMemory(facts.execution.managementState);
      if (memory.pendingManagement?.commandId)
        return refuse("MANAGEMENT_CLAIM_ALREADY_LINKED");
      const command = await create(tx, facts, bridge);
      await tx
        .update(executions)
        .set({
          managementState: {
            ...memory,
            pendingManagement: {
              ...memory.pendingManagement!,
              commandId: command.commandId,
            },
            ...(target.action === "EXIT"
              ? { closeCommandId: command.commandId }
              : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(executions.id, facts.execution.id));
      return command;
    },
    database,
  );
}

/** Additional refusal after all current gates; does not enable any action. */
export function claimManagementCommand(
  expected: ArxLiveCommand,
  requiredStatus: string,
  patch: Partial<typeof commands.$inferInsert>,
  database: typeof db = db,
): Promise<ArxLiveCommand | null> {
  const target = managementTargetFromCommand(expected);
  if (!target)
    return Promise.reject(
      new ManagementTargetError("MANAGEMENT_TARGET_REQUIRED"),
    );
  return withTarget(
    target,
    async (tx, facts, bridge) => {
      const [current] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.commandId, expected.commandId),
            eq(commands.userId, expected.userId),
          ),
        )
        .for("update");
      if (!current || current.status !== requiredStatus) return null;
      if (!supportsManagementTarget(bridge.capabilities)) refuse("MANAGEMENT_TERMINAL_UPGRADE_REQUIRED");
      if (
        !isDeepStrictEqual(current, expected) ||
        readManagementMemory(facts.execution.managementState).pendingManagement
          ?.commandId !== current.commandId ||
        current.sourcePage !== MANAGEMENT_TARGET_SOURCE ||
        current.source !== MANAGEMENT_TARGET_SOURCE ||
        current.actorType !== "SELF_TRADE_AGENT" ||
        current.actorId !== target.userId ||
        current.selfTradeAgentId !== target.agentId ||
        current.selfTradeDecisionId !== target.decisionId ||
        current.bridgeConnectionId !== bridge.id ||
        current.accountLogin !== target.accountLogin ||
        current.brokerServer !== target.legacyBrokerCompany
      )
        refuse("MANAGEMENT_COMMAND_CHANGED");
      assertManagementGeometry(target, {
        userId: current.userId,
        commandType: current.commandType,
        symbol: current.symbol,
        side: current.side,
        volume: current.requestedVolume,
        brokerTicket: String(
          (current.payload as Record<string, unknown>).brokerTicket ?? "",
        ),
        newStopLoss: current.stopLoss,
        newTakeProfit: current.takeProfit,
      });
      for (const key of [
        "userId",
        "commandType",
        "symbol",
        "side",
        "orderType",
        "requestedVolume",
        "stopLoss",
        "takeProfit",
        "payload",
        "actorId",
        "actorType",
        "selfTradeAgentId",
        "selfTradeDecisionId",
        "bridgeConnectionId",
        "accountLogin",
        "brokerServer",
      ] as const) {
        if (key in patch && !isDeepStrictEqual(patch[key], current[key]))
          refuse("MANAGEMENT_DISPATCH_RETARGETED");
      }
      if (patch.expiresAt != null && patch.expiresAt.getTime() <= Date.now())
        refuse("MANAGEMENT_COMMAND_EXPIRED");
      // The decision used a broker snapshot. At the final claim the locked row
      // must still be a current observation (geometry equality is checked above
      // via the target); a stale or future-dated snapshot refuses.
      if (requiredStatus === "LIVE_APPROVED") {
        const observed = evaluatePositionObservation({
          lastSyncedAt: facts.position?.lastSyncedAt,
          commandEventTimes: [facts.entry?.filledAt],
          nowMs: Date.now(),
        });
        if (!observed.ok) refuse(observed.reason);
        // Protective-action parity: a claim taken by the protective path was
        // justified by a specific complete-sweep row. The locked row must still
        // be sweep evidence at least as new as that, and a stop move must still
        // tighten against the locked price. Pure evaluation over rows already
        // locked above; no new statement, no new lock.
        const protective = readManagementMemory(facts.execution.managementState)
          .pendingManagement?.protective;
        if (protective) {
          const evidence = evaluateProtectiveObservation({
            row: facts.position!,
            connection: bridge,
            mustNotPrecedeMs:
              parseObservationTime(protective.evidence?.lastSyncedAt) ?? Number.NaN,
            commandEventTimes: [facts.entry?.filledAt],
            nowMs: Date.now(),
          });
          if (!evidence.ok) refuse(evidence.reason);
          if (target.action !== "EXIT") {
            const geometry = doesNotLoosenStop(
              {
                side: target.side,
                volume: facts.position!.volume,
                entryPrice: facts.position!.entryPrice,
                currentPrice: facts.position!.currentPrice as number,
                stopLoss: facts.position!.stopLoss,
                takeProfit: facts.position!.takeProfit,
              },
              {
                kind: "MODIFY_STOP",
                side: target.side,
                newStopLoss: target.nextStopLoss as number,
                newTakeProfit: target.currentTakeProfit,
              },
            );
            if (!geometry.ok) refuse(geometry.reason);
          }
        }
      }
      const [claimed] = await tx
        .update(commands)
        .set(patch)
        .where(
          and(
            eq(commands.commandId, current.commandId),
            eq(commands.userId, target.userId),
            eq(commands.status, requiredStatus),
          ),
        )
        .returning();
      return claimed ?? null;
    },
    database,
  );
}

/** Exact native symbol for bound management; no second global mapping. */
export function boundManagementTransportSymbol(
  row: ArxLiveCommand,
): string | null {
  if (!isAgentManagementCommand(row)) return null;
  const target = managementTargetFromCommand(row);
  if (
    !target ||
    target.userId !== row.userId ||
    target.symbol !== row.symbol ||
    target.bridgeConnectionId !== row.bridgeConnectionId ||
    target.accountLogin !== row.accountLogin ||
    target.legacyBrokerCompany !== row.brokerServer
  )
    return refuse("MANAGEMENT_TRANSPORT_TARGET_MISMATCH");
  assertManagementGeometry(target, {
    userId: row.userId,
    commandType: row.commandType,
    symbol: row.symbol,
    side: row.side,
    volume: row.requestedVolume,
    brokerTicket: String(
      (row.payload as Record<string, unknown>).brokerTicket ?? "",
    ),
    newStopLoss: row.stopLoss,
    newTakeProfit: row.takeProfit,
  });
  return target.symbol;
}
