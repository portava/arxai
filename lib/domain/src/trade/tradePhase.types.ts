import { z } from "zod/v4";
import type { TradeStatus } from "./trade.types";

// ── 11-phase operational lifecycle ─────────────────────────────────────────
// Finer-grained than TradeStatus. TradeStatus is what's persisted in the DB
// (PENDING/OPEN/MANAGING/CLOSED_*/CANCELLED/EXPIRED). TradePhase is the
// operational view the UI and event bus speak in — every phase change emits
// a TRADE_UPDATED event, even when the persisted status hasn't changed.
export const TradeLifecyclePhaseSchema = z.enum([
  "WATCHING",        // scanner sweeping symbol, no setup yet
  "SIGNAL_READY",    // setup detected, awaiting validation
  "RISK_CHECKING",   // running risk gates
  "APPROVED",        // gates passed, ready for order send
  "ORDER_PENDING",   // sent to broker, awaiting fill
  "LIVE",            // filled, in market, no active management yet
  "MANAGING",        // active management (BE move / trailing)
  "PARTIAL_TAKEN",   // a partial close has executed; trade still open
  "EXIT_WARNING",    // health critical, near SL — flagged for operator
  "CLOSED",          // fully exited
  "REVIEWED",        // post-trade review/learning logged → terminal
]);
export type TradeLifecyclePhase = z.infer<typeof TradeLifecyclePhaseSchema>;

// ── Allowed forward transitions ────────────────────────────────────────────
// Defines the *only* legal moves. Anything else is rejected.
const TRANSITIONS: Record<TradeLifecyclePhase, TradeLifecyclePhase[]> = {
  WATCHING:      ["SIGNAL_READY"],
  SIGNAL_READY:  ["RISK_CHECKING", "WATCHING"],                           // setup invalidated → back to watching
  RISK_CHECKING: ["APPROVED", "WATCHING"],                                // gates failed → drop, resume watching
  APPROVED:      ["ORDER_PENDING", "WATCHING"],                           // operator/system aborted before send
  ORDER_PENDING: ["LIVE", "WATCHING"],                                    // fill rejected → drop
  LIVE:          ["MANAGING", "EXIT_WARNING", "CLOSED"],
  MANAGING:      ["PARTIAL_TAKEN", "EXIT_WARNING", "CLOSED"],
  PARTIAL_TAKEN: ["MANAGING", "EXIT_WARNING", "CLOSED"],
  EXIT_WARNING:  ["MANAGING", "PARTIAL_TAKEN", "CLOSED"],                 // recovers, or closes
  CLOSED:        ["REVIEWED"],
  REVIEWED:      [],
};

export interface TradePhaseTransitionResult {
  ok: boolean;
  from: TradeLifecyclePhase;
  to: TradeLifecyclePhase;
  reason?: string;
}

export function canTransitionPhase(from: TradeLifecyclePhase, to: TradeLifecyclePhase): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionPhase(
  from: TradeLifecyclePhase,
  to: TradeLifecyclePhase,
): TradePhaseTransitionResult {
  if (!canTransitionPhase(from, to)) {
    return { ok: false, from, to, reason: `Illegal phase transition ${from} → ${to}` };
  }
  return { ok: true, from, to };
}

export function nextAllowedPhases(from: TradeLifecyclePhase): TradeLifecyclePhase[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminalPhase(phase: TradeLifecyclePhase): boolean {
  return TRANSITIONS[phase].length === 0;
}

// ── Phase metadata for UI rendering & event filtering ──────────────────────
export type PhaseTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface PhaseMetadata {
  phase: TradeLifecyclePhase;
  label: string;
  tone: PhaseTone;
  hasOpenPosition: boolean;   // true when a position exists in the broker
  hasFinalPnL: boolean;       // true once fully exited
  isActionable: boolean;      // true when the operator typically acts on it
}

export const PHASE_META: Record<TradeLifecyclePhase, PhaseMetadata> = {
  WATCHING:      { phase: "WATCHING",      label: "Watching",      tone: "neutral", hasOpenPosition: false, hasFinalPnL: false, isActionable: false },
  SIGNAL_READY:  { phase: "SIGNAL_READY",  label: "Signal Ready",  tone: "info",    hasOpenPosition: false, hasFinalPnL: false, isActionable: true  },
  RISK_CHECKING: { phase: "RISK_CHECKING", label: "Risk Checking", tone: "info",    hasOpenPosition: false, hasFinalPnL: false, isActionable: false },
  APPROVED:      { phase: "APPROVED",      label: "Approved",      tone: "success", hasOpenPosition: false, hasFinalPnL: false, isActionable: true  },
  ORDER_PENDING: { phase: "ORDER_PENDING", label: "Order Pending", tone: "info",    hasOpenPosition: false, hasFinalPnL: false, isActionable: false },
  LIVE:          { phase: "LIVE",          label: "Live",          tone: "success", hasOpenPosition: true,  hasFinalPnL: false, isActionable: true  },
  MANAGING:      { phase: "MANAGING",      label: "Managing",      tone: "info",    hasOpenPosition: true,  hasFinalPnL: false, isActionable: true  },
  PARTIAL_TAKEN: { phase: "PARTIAL_TAKEN", label: "Partial Taken", tone: "success", hasOpenPosition: true,  hasFinalPnL: false, isActionable: true  },
  EXIT_WARNING:  { phase: "EXIT_WARNING",  label: "Exit Warning",  tone: "warning", hasOpenPosition: true,  hasFinalPnL: false, isActionable: true  },
  CLOSED:        { phase: "CLOSED",        label: "Closed",        tone: "neutral", hasOpenPosition: false, hasFinalPnL: true,  isActionable: true  },
  REVIEWED:      { phase: "REVIEWED",      label: "Reviewed",      tone: "neutral", hasOpenPosition: false, hasFinalPnL: true,  isActionable: false },
};

// ── Mapping between TradePhase ↔ persisted TradeStatus ────────────────────
// Many phases collapse onto the same persisted status (e.g. WATCHING /
// SIGNAL_READY / RISK_CHECKING / APPROVED / ORDER_PENDING all live under
// PENDING in the DB).
export function phaseToStatus(phase: TradeLifecyclePhase): TradeStatus | null {
  switch (phase) {
    case "WATCHING":
    case "SIGNAL_READY":
    case "RISK_CHECKING":
    case "APPROVED":
    case "ORDER_PENDING": return "PENDING";
    case "LIVE":          return "OPEN";
    case "MANAGING":
    case "PARTIAL_TAKEN":
    case "EXIT_WARNING":  return "MANAGING";
    case "CLOSED":        return null;       // outcome (WIN/LOSS/BE) decided by classifyClose
    case "REVIEWED":      return null;       // already terminal at the DB level
  }
}

// Reverse: given a persisted status, what phase should the UI default to
// when no finer phase has been recorded yet (e.g. after a server restart)?
export function statusToDefaultPhase(status: TradeStatus): TradeLifecyclePhase {
  switch (status) {
    case "PENDING":           return "ORDER_PENDING";
    case "OPEN":              return "LIVE";
    case "MANAGING":          return "MANAGING";
    case "CLOSED_WIN":
    case "CLOSED_LOSS":
    case "CLOSED_BREAKEVEN":  return "CLOSED";
    case "CANCELLED":
    case "EXPIRED":           return "REVIEWED";
  }
}
