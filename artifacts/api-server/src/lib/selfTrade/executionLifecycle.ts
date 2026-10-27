// Evidence rules shared by reconciliation and management. Acceptance, unknown
// outcomes and partial fills never become completed actions by elapsed time.
import type { ArxLiveCommand, SelfTradeAgentExecution } from "@workspace/db";
import type {
  ManagementAction,
  ProtectiveTrigger,
} from "@workspace/domain/self-trade";
import { isValidFillPrice } from "../live/realizedPnl.js";

/**
 * Evidence a protective claim was taken on: the fresh sweep row and bridge
 * facts that passed the stricter protective standard. The final claim refuses
 * when the locked row precedes this evidence (managementTarget.ts).
 */
export interface ProtectiveClaimEvidence {
  lastSyncedAt: string;
  sweepAt: string;
  heartbeatAt: string;
  serverName: string;
  currentPrice: number;
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface ProtectiveClaim {
  trigger: ProtectiveTrigger;
  /** The ordinary observation hold this protective action started from. */
  heldReason: string;
  heldAtMs: number;
  evidence: ProtectiveClaimEvidence;
}

export interface PendingManagement {
  claimId: string;
  action: "MOVE_TO_BE" | "TIGHTEN_SL" | "EXIT";
  requestedAt: string;
  stopLoss: number | null;
  commandId?: string;
  /** Present only when the protective-action path took the claim. */
  protective?: ProtectiveClaim;
}

export interface ManagementMemory {
  beMoved?: boolean;
  partialsTaken?: number;
  lastAction?: ManagementAction;
  closeCommandId?: string;
  pendingManagement?: PendingManagement;
  closeAccounting?: {
    status: "UNVERIFIED";
    reason: "HISTORICAL_ACCOUNTING_EVIDENCE_MISSING";
    entryCommandId: string;
    symbol: string;
    userId: number;
    agentId: number;
    accountLogin: string;
    bridgeConnectionId: number;
    observedServerName: string;
  };
}

export function readManagementMemory(value: unknown): ManagementMemory {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as ManagementMemory)
    : {};
}

/** Read-only operator explanation; elapsed time never releases a reservation. */
export function managementNote(
  execution: Pick<SelfTradeAgentExecution, "status" | "managementState">,
  now = Date.now(),
): string | null {
  const memory = readManagementMemory(execution.managementState);
  if (
    execution.status === "CLOSED" &&
    memory.closeAccounting?.status === "UNVERIFIED"
  )
    return "Close recorded; profit remains unverified because the original account valuation details are unavailable.";
  if (execution.status !== "FILLED") return null;
  const pending = memory.pendingManagement;
  if (!pending)
    return memory.closeCommandId ? "Close awaiting broker confirmation." : null;
  if (pending.commandId) {
    if (pending.protective)
      return pending.action === "EXIT"
        ? "Protective close awaiting broker confirmation."
        : "Protective stop change awaiting broker confirmation.";
    return pending.action === "EXIT"
      ? "Close awaiting broker confirmation."
      : "Stop change awaiting broker confirmation.";
  }
  const requestedAt = Date.parse(pending.requestedAt);
  return Number.isFinite(requestedAt) &&
    now >= requestedAt &&
    now - requestedAt < 30_000
    ? "Management request being prepared."
    : "Management outcome needs review; automatic retries are held.";
}

export function validEvidenceTime(
  value: Date | null | undefined,
): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

type EntryResolution =
  | {
      status: "FILLED";
      brokerTicket: string;
      fillPrice: number;
      filledAt: Date;
    }
  | { status: "DISPATCHED"; openedAt: Date | null }
  | { status: "REJECTED" | "BLOCKED" | "EXPIRED"; blockReason: string };

const ENTRY_TYPES = new Set([
  "PLACE_LIVE_MARKET_ORDER",
  "PLACE_LIVE_PENDING_ORDER",
]);
const WORKING_STATUSES = new Set([
  "SENT_TO_MT5_LIVE",
  "LIVE_ACKNOWLEDGED",
  "LIVE_PARTIALLY_FILLED",
  "LIVE_UNKNOWN",
  "LIVE_RECONCILIATION_REQUIRED",
]);
export const CONFIRMED_NON_EXECUTION = new Set([
  "LIVE_REJECTED",
  "LIVE_FAILED",
  "LIVE_BLOCKED",
  "LIVE_CANCELLED",
  "LIVE_EXPIRED",
]);

/** Identity comes from the persisted, attributed draft and its dispatch account. */
export function ownedEntryBinding(
  execution: SelfTradeAgentExecution,
  command: ArxLiveCommand | undefined,
) {
  if (!command) return null;
  const binding = (
    command.payload as {
      selfTradeSymbolBinding?: {
        requestedSymbol?: unknown;
        brokerSymbol?: unknown;
      };
    } | null
  )?.selfTradeSymbolBinding;
  if (
    execution.commandId !== command.commandId ||
    execution.executingUserId == null ||
    command.userId !== execution.executingUserId ||
    command.selfTradeAgentId !== execution.agentId ||
    command.selfTradeDecisionId !== execution.decisionId ||
    !ENTRY_TYPES.has(command.commandType) ||
    command.side !== execution.side ||
    !command.symbol?.trim() ||
    // Older drafts without provenance can only prove an exact symbol match.
    (binding == null
      ? command.symbol !== execution.symbol
      : binding.requestedSymbol !== execution.symbol ||
        binding.brokerSymbol !== command.symbol)
  )
    return null;
  return command;
}

export function sameBrokerAccount(
  a: Pick<
    ArxLiveCommand,
    "bridgeConnectionId" | "accountLogin" | "brokerServer"
  >,
  b: Pick<
    ArxLiveCommand,
    "bridgeConnectionId" | "accountLogin" | "brokerServer"
  >,
): boolean {
  return (
    Number.isInteger(a.bridgeConnectionId) &&
    (a.bridgeConnectionId ?? 0) > 0 &&
    typeof a.accountLogin === "string" &&
    a.accountLogin.trim().length > 0 &&
    typeof a.brokerServer === "string" &&
    a.brokerServer.trim().length > 0 &&
    a.bridgeConnectionId === b.bridgeConnectionId &&
    a.accountLogin === b.accountLogin &&
    a.brokerServer === b.brokerServer
  );
}

export function fullVolumeEvidence(
  command: ArxLiveCommand,
  expectedVolume: number,
): boolean {
  if (
    !isValidFillPrice(expectedVolume) ||
    !isValidFillPrice(command.requestedVolume) ||
    !isValidFillPrice(command.executedVolume)
  )
    return false;
  const tolerance = Math.max(1, expectedVolume) * Number.EPSILON * 16;
  return (
    Math.abs(command.requestedVolume - expectedVolume) <= tolerance &&
    Math.abs(command.executedVolume - expectedVolume) <= tolerance
  );
}

/** A command link alone is insufficient: verify the owning user and decision. */
export function resolveEntryEvidence(
  execution: SelfTradeAgentExecution,
  command: ArxLiveCommand,
): EntryResolution | null {
  if (!ownedEntryBinding(execution, command)) return null;

  if (
    command.status === "LIVE_FILLED" &&
    sameBrokerAccount(command, command) &&
    fullVolumeEvidence(command, execution.intendedVolume) &&
    command.brokerTicket?.trim() &&
    isValidFillPrice(command.fillPrice) &&
    validEvidenceTime(command.filledAt)
  ) {
    return {
      status: "FILLED",
      brokerTicket: command.brokerTicket,
      fillPrice: command.fillPrice,
      filledAt: command.filledAt,
    };
  }
  if (WORKING_STATUSES.has(command.status)) {
    return {
      status: "DISPATCHED",
      openedAt: validEvidenceTime(command.sentToMt5At)
        ? command.sentToMt5At
        : null,
    };
  }
  if (CONFIRMED_NON_EXECUTION.has(command.status)) {
    // Cancellation/rejection of a remaining quantity does not erase a partial
    // fill. Preserve the unresolved execution for reconciliation of exposure.
    if (isValidFillPrice(command.executedVolume)) return null;
    const status =
      command.status === "LIVE_EXPIRED"
        ? "EXPIRED"
        : command.status === "LIVE_REJECTED" || command.status === "LIVE_FAILED"
          ? "REJECTED"
          : "BLOCKED";
    return {
      status,
      blockReason:
        command.rejectionReason ?? command.brokerMessage ?? command.status,
    };
  }
  return null;
}

export function isOwnedManagementCommand(
  execution: SelfTradeAgentExecution,
  command: ArxLiveCommand,
  action: "EXIT" | "MOVE_TO_BE" | "TIGHTEN_SL",
  entryCommand: ArxLiveCommand | undefined,
): boolean {
  const entry = ownedEntryBinding(execution, entryCommand);
  if (
    !entry ||
    !sameBrokerAccount(entry, command) ||
    !fullVolumeEvidence(entry, execution.intendedVolume) ||
    entry.brokerTicket !== execution.brokerTicket
  )
    return false;
  const payload = command.payload as { brokerTicket?: unknown } | null;
  return (
    execution.executingUserId != null &&
    command.userId === execution.executingUserId &&
    command.commandType ===
      (action === "EXIT" ? "CLOSE_LIVE_POSITION" : "MODIFY_LIVE_SLTP") &&
    command.symbol === entry.symbol &&
    payload?.brokerTicket === execution.brokerTicket
  );
}

export function confirmedCloseTime(
  command: ArxLiveCommand,
  expectedVolume: number,
): Date | null {
  if (
    (command.status !== "LIVE_FILLED" && command.status !== "LIVE_CLOSED") ||
    !isValidFillPrice(command.fillPrice) ||
    !fullVolumeEvidence(command, expectedVolume)
  )
    return null;
  return validEvidenceTime(command.closedAt)
    ? command.closedAt
    : validEvidenceTime(command.filledAt)
      ? command.filledAt
      : null;
}

export function stopAtLeastAsProtective(
  side: string,
  observed: number | null,
  requested: number,
): boolean {
  if (!isValidFillPrice(observed) || !isValidFillPrice(requested)) return false;
  const epsilon = Math.max(1, Math.abs(requested)) * Number.EPSILON * 8;
  return side === "BUY"
    ? observed >= requested - epsilon
    : side === "SELL"
      ? observed <= requested + epsilon
      : false;
}

export type PendingResolution = "CONFIRMED" | "REJECTED" | "WAIT";

export function resolvePendingManagement(
  execution: SelfTradeAgentExecution,
  pending: PendingManagement,
  command: ArxLiveCommand | undefined,
  observedStop: number | null,
  entryCommand: ArxLiveCommand | undefined,
): PendingResolution {
  if (
    !pending.commandId ||
    !command ||
    command.commandId !== pending.commandId ||
    !isOwnedManagementCommand(execution, command, pending.action, entryCommand)
  )
    return "WAIT";
  if (CONFIRMED_NON_EXECUTION.has(command.status)) {
    return pending.action === "EXIT" && isValidFillPrice(command.executedVolume)
      ? "WAIT"
      : "REJECTED";
  }
  // EXIT is settled by the execution reconciler using the actual close fill.
  if (pending.action === "EXIT") return "WAIT";
  if (
    command.status !== "LIVE_FILLED" ||
    !validEvidenceTime(command.filledAt) ||
    !isValidFillPrice(pending.stopLoss) ||
    command.stopLoss !== pending.stopLoss
  )
    return "WAIT";
  return stopAtLeastAsProtective(execution.side, observedStop, pending.stopLoss)
    ? "CONFIRMED"
    : "WAIT";
}
