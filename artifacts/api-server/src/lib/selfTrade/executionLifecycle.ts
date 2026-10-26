// Evidence rules shared by reconciliation and management. Acceptance, unknown
// outcomes and partial fills never become completed actions by elapsed time.
import type { ArxLiveCommand, SelfTradeAgentExecution } from "@workspace/db";
import type { ManagementAction } from "@workspace/domain/self-trade";
import { isValidFillPrice } from "../live/realizedPnl.js";

export interface PendingManagement {
  claimId: string;
  action: "MOVE_TO_BE" | "TIGHTEN_SL" | "EXIT";
  requestedAt: string;
  stopLoss: number | null;
  commandId?: string;
}

export interface ManagementMemory {
  beMoved?: boolean;
  partialsTaken?: number;
  lastAction?: ManagementAction;
  closeCommandId?: string;
  pendingManagement?: PendingManagement;
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
  if (execution.status !== "FILLED") return null;
  const memory = readManagementMemory(execution.managementState);
  const pending = memory.pendingManagement;
  if (!pending)
    return memory.closeCommandId ? "Close awaiting broker confirmation." : null;
  if (pending.commandId) {
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

/** A command link alone is insufficient: verify the owning user and decision. */
export function resolveEntryEvidence(
  execution: SelfTradeAgentExecution,
  command: ArxLiveCommand,
): EntryResolution | null {
  if (
    execution.commandId !== command.commandId ||
    execution.executingUserId == null ||
    command.userId !== execution.executingUserId ||
    command.selfTradeAgentId !== execution.agentId ||
    command.selfTradeDecisionId !== execution.decisionId ||
    !ENTRY_TYPES.has(command.commandType) ||
    command.symbol !== execution.symbol ||
    command.side !== execution.side
  )
    return null;

  if (
    command.status === "LIVE_FILLED" &&
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
): boolean {
  const payload = command.payload as { brokerTicket?: unknown } | null;
  return (
    execution.executingUserId != null &&
    command.userId === execution.executingUserId &&
    command.commandType ===
      (action === "EXIT" ? "CLOSE_LIVE_POSITION" : "MODIFY_LIVE_SLTP") &&
    command.symbol === execution.symbol &&
    payload?.brokerTicket === execution.brokerTicket
  );
}

export function confirmedCloseTime(command: ArxLiveCommand): Date | null {
  if (
    (command.status !== "LIVE_FILLED" && command.status !== "LIVE_CLOSED") ||
    !isValidFillPrice(command.fillPrice)
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
): PendingResolution {
  if (
    !pending.commandId ||
    !command ||
    command.commandId !== pending.commandId ||
    !isOwnedManagementCommand(execution, command, pending.action)
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
