import { z } from "zod/v4";
import type { TradingAppState } from "../state/appState.types";
import type { FeatureFlag } from "../flags/featureFlags.types";
import type { OperatingMode } from "../flags/featureFlags.engine";
import type { TradeLifecyclePhase } from "../trade/tradePhase.types";
import type { DomainEvent } from "../events/domainEvents.types";

// ────────────────────────────────────────────────────────────────────────────
// COMMANDS — every operator action the UI can trigger
// ────────────────────────────────────────────────────────────────────────────
export const CommandKindSchema = z.enum([
  "BOT_START",
  "BOT_STOP",
  "BOT_PAUSE",
  "BOT_RESUME",
  "EMERGENCY_KILL",
  "FLAG_SET",
  "RISK_OVERRIDE_SET",
  "RISK_OVERRIDE_CLEAR",
  "SIGNAL_APPROVE",
  "SIGNAL_REJECT",
  "TRADE_CLOSE",
  "TRADE_PARTIAL_CLOSE",
  "TRADE_MOVE_SL",
  "STRATEGY_TOGGLE",
  "JOURNAL_SEAL",
  "EVENT_ACKNOWLEDGE",
]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

interface CommandBase {
  id: string;                       // client-generated id for correlation
  kind: CommandKind;
  issuedBy: string;                 // operator id
  issuedAt: string;                 // ISO
  reason?: string;
  confirmedBy?: string;             // present when multi-step confirm satisfied
}

export type Command =
  | (CommandBase & { kind: "BOT_START" })
  | (CommandBase & { kind: "BOT_STOP" })
  | (CommandBase & { kind: "BOT_PAUSE" })
  | (CommandBase & { kind: "BOT_RESUME" })
  | (CommandBase & { kind: "EMERGENCY_KILL" })
  | (CommandBase & { kind: "FLAG_SET";              flag: FeatureFlag; enabled: boolean })
  | (CommandBase & { kind: "RISK_OVERRIDE_SET";     state: "FORCE_ALLOW" | "FORCE_BLOCK"; expiresAt?: string })
  | (CommandBase & { kind: "RISK_OVERRIDE_CLEAR" })
  | (CommandBase & { kind: "SIGNAL_APPROVE";        signalId: string })
  | (CommandBase & { kind: "SIGNAL_REJECT";         signalId: string })
  | (CommandBase & { kind: "TRADE_CLOSE";           tradeId: string | number })
  | (CommandBase & { kind: "TRADE_PARTIAL_CLOSE";   tradeId: string | number; fraction: number })
  | (CommandBase & { kind: "TRADE_MOVE_SL";         tradeId: string | number; newStopLoss: number })
  | (CommandBase & { kind: "STRATEGY_TOGGLE";       strategyName: string; enabled: boolean })
  | (CommandBase & { kind: "JOURNAL_SEAL";          tradeId: string | number })
  | (CommandBase & { kind: "EVENT_ACKNOWLEDGE";     eventId: string });

// ────────────────────────────────────────────────────────────────────────────
// COMMAND RESULTS — what the UI shows after dispatch
// ────────────────────────────────────────────────────────────────────────────
export const CommandStatusSchema = z.enum([
  "OK",
  "REJECTED",                       // domain validation failed (e.g. flag confirm missing)
  "REQUIRES_CONFIRMATION",          // UI must run multi-step flow then re-issue
  "ERRORED",                        // unexpected (port threw)
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export interface CommandResult {
  commandId: string;
  kind: CommandKind;
  status: CommandStatus;
  message: string;
  reasons: string[];                // structured per-rule reasons
  events: DomainEvent[];            // events emitted by handling this command
  at: string;                       // ISO
}

// ────────────────────────────────────────────────────────────────────────────
// VIEWS — state slices shaped for direct UI consumption
// ────────────────────────────────────────────────────────────────────────────
export interface BotStatusView {
  botStatus: "RUNNING" | "PAUSED" | "STOPPED";
  operatingMode: OperatingMode;
  killSwitchEngaged: boolean;
  lastTickAt: string | null;
}

export interface AccountView {
  balance: number;
  equity: number;
  marginUsedPct: number;
  todayPnl: number;
  todayPnlPct: number;
  openTradesCount: number;
}

export interface SignalRow {
  id: string;
  symbol: string;
  strategy: string;
  action: "BUY" | "SELL" | "WAIT" | "AVOID";
  confidence: number;
  createdAt: string;
  reasons: string[];
}

export interface TradeRow {
  id: string | number;
  symbol: string;
  direction: "BUY" | "SELL";
  phase: TradeLifecyclePhase;
  phaseLabel: string;
  phaseTone: "neutral" | "info" | "success" | "warning" | "danger";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  unrealizedPnl: number;
  rMultiple: number;
  healthScore: number;
}

export interface FlagRow {
  flag: FeatureFlag;
  label: string;
  enabled: boolean;
  danger: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  setBy: string | null;
  setAt: string;
  requiresConfirmation: boolean;
}

export interface AlertRow {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  at: string;
  acknowledged: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// UI PORT — the contract between React and the domain runtime
// ────────────────────────────────────────────────────────────────────────────
export interface UIPort {
  readState(): TradingAppState;
  dispatch(command: Command): Promise<CommandResult>;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}
