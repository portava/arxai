import type {
  Command, CommandKind, CommandResult, CommandStatus,
} from "./ui.types";
import type { DomainEvent } from "../events/domainEvents.types";

// ── Command factory: stamps id + issuedAt; caller passes intent + payload ──
let counter = 0;
function makeId(): string {
  counter = (counter + 1) % 1_000_000;
  return `cmd_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function makeCommand<K extends CommandKind>(
  kind: K,
  issuedBy: string,
  payload: Omit<Extract<Command, { kind: K }>, "id" | "kind" | "issuedAt" | "issuedBy">,
  opts: { reason?: string; confirmedBy?: string; now?: Date } = {},
): Extract<Command, { kind: K }> {
  return {
    id: makeId(),
    kind,
    issuedBy,
    issuedAt: (opts.now ?? new Date()).toISOString(),
    reason: opts.reason,
    confirmedBy: opts.confirmedBy,
    ...(payload as object),
  } as Extract<Command, { kind: K }>;
}

// ── Result helpers — uniform shape so UI never branches on shape ───────────
export function commandOk(
  command: Command,
  message: string,
  events: DomainEvent[] = [],
  now: Date = new Date(),
): CommandResult {
  return resultOf(command, "OK", message, [], events, now);
}

export function commandRejected(
  command: Command,
  message: string,
  reasons: string[],
  now: Date = new Date(),
): CommandResult {
  return resultOf(command, "REJECTED", message, reasons, [], now);
}

export function commandRequiresConfirmation(
  command: Command,
  message: string,
  now: Date = new Date(),
): CommandResult {
  return resultOf(command, "REQUIRES_CONFIRMATION", message, [], [], now);
}

export function commandErrored(
  command: Command,
  message: string,
  now: Date = new Date(),
): CommandResult {
  return resultOf(command, "ERRORED", message, [], [], now);
}

function resultOf(
  command: Command, status: CommandStatus, message: string,
  reasons: string[], events: DomainEvent[], now: Date,
): CommandResult {
  return {
    commandId: command.id,
    kind: command.kind,
    status, message, reasons, events,
    at: now.toISOString(),
  };
}

// ── Static command metadata — what the UI needs to render the action ──────
export interface CommandMetadata {
  kind: CommandKind;
  label: string;
  danger: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requiresConfirmation: boolean;
  description: string;
}

export const COMMAND_META: Record<CommandKind, CommandMetadata> = {
  BOT_START:             { kind: "BOT_START",             label: "Start Bot",             danger: "MEDIUM",   requiresConfirmation: false, description: "Resume scanning + signal generation" },
  BOT_STOP:              { kind: "BOT_STOP",              label: "Stop Bot",              danger: "MEDIUM",   requiresConfirmation: false, description: "Halt scanning; keep open trades" },
  BOT_PAUSE:             { kind: "BOT_PAUSE",             label: "Pause Bot",             danger: "LOW",      requiresConfirmation: false, description: "Temporarily suspend new entries" },
  BOT_RESUME:            { kind: "BOT_RESUME",            label: "Resume Bot",            danger: "LOW",      requiresConfirmation: false, description: "Resume from paused state" },
  EMERGENCY_KILL:        { kind: "EMERGENCY_KILL",        label: "EMERGENCY KILL",        danger: "CRITICAL", requiresConfirmation: true,  description: "Stop bot AND close all open trades immediately" },
  FLAG_SET:              { kind: "FLAG_SET",              label: "Set Flag",              danger: "HIGH",     requiresConfirmation: true,  description: "Toggle a feature flag (per-flag confirm rules apply)" },
  RISK_OVERRIDE_SET:     { kind: "RISK_OVERRIDE_SET",     label: "Set Risk Override",     danger: "HIGH",     requiresConfirmation: true,  description: "Force-allow or force-block at the risk gate level" },
  RISK_OVERRIDE_CLEAR:   { kind: "RISK_OVERRIDE_CLEAR",   label: "Clear Risk Override",   danger: "LOW",      requiresConfirmation: false, description: "Remove any active manual override" },
  SIGNAL_APPROVE:        { kind: "SIGNAL_APPROVE",        label: "Approve Signal",        danger: "MEDIUM",   requiresConfirmation: false, description: "Approve a queued signal for execution" },
  SIGNAL_REJECT:         { kind: "SIGNAL_REJECT",         label: "Reject Signal",         danger: "LOW",      requiresConfirmation: false, description: "Reject a queued signal" },
  TRADE_CLOSE:           { kind: "TRADE_CLOSE",           label: "Close Trade",           danger: "MEDIUM",   requiresConfirmation: true,  description: "Close an open trade at market" },
  TRADE_PARTIAL_CLOSE:   { kind: "TRADE_PARTIAL_CLOSE",   label: "Partial Close",         danger: "LOW",      requiresConfirmation: false, description: "Close a fraction of an open trade" },
  TRADE_MOVE_SL:         { kind: "TRADE_MOVE_SL",         label: "Move Stop Loss",        danger: "MEDIUM",   requiresConfirmation: false, description: "Update SL on an open trade" },
  STRATEGY_TOGGLE:       { kind: "STRATEGY_TOGGLE",       label: "Toggle Strategy",       danger: "MEDIUM",   requiresConfirmation: false, description: "Enable / disable a strategy in the registry" },
  JOURNAL_SEAL:          { kind: "JOURNAL_SEAL",          label: "Seal Journal Entry",    danger: "LOW",      requiresConfirmation: false, description: "Mark a closed trade journal as reviewed (immutable)" },
  EVENT_ACKNOWLEDGE:     { kind: "EVENT_ACKNOWLEDGE",     label: "Acknowledge Alert",     danger: "LOW",      requiresConfirmation: false, description: "Mark an alert as seen" },
};

// ── Pre-dispatch validation — UI calls this before sending the command ────
//   • Confirms multi-step satisfied for confirmation-required commands
//   • Confirms confirmedBy ≠ issuedBy
export function validateCommand(command: Command): { ok: boolean; reasons: string[] } {
  const meta = COMMAND_META[command.kind];
  const reasons: string[] = [];
  if (meta.requiresConfirmation) {
    if (!command.confirmedBy) reasons.push(`${meta.label} requires multi-step confirmation`);
    else if (command.confirmedBy === command.issuedBy) reasons.push("confirmedBy must differ from issuedBy");
  }
  if (!command.issuedBy?.trim()) reasons.push("issuedBy is required");
  return { ok: reasons.length === 0, reasons };
}
