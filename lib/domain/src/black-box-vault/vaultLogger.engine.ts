// ═══════════════════════════════════════════════════════════════════════════
// Vault Logger Engine — pure event taxonomy and builder functions for
// every category the Phase 2 spec requires the system to log.
//
// This module is PURE: it has no IO, no DB, no clock. It produces fully-
// formed VaultEventInput objects that an outer adapter (server, in-memory,
// test) writes to whatever store it likes. This is what makes the same
// taxonomy reusable in unit tests, replays, and production.
//
// Spec coverage (all 13 categories the user listed):
//   1.  mode changes              → buildModeChangeEvent
//   2.  blocked trades            → buildBlockedTradeEvent
//   3.  approved trades           → buildApprovedTradeEvent
//   4.  rejected trades           → buildRejectedTradeEvent
//   5.  risk decisions            → buildRiskDecisionEvent
//   6.  kill switch events        → buildKillSwitchEngagedEvent / Reset
//   7.  recovery mode events      → buildRecoveryEvent
//   8.  MT5 disconnects           → buildMt5DisconnectEvent
//   9.  latency spikes            → buildLatencySpikeEvent
//  10.  spread changes            → buildSpreadChangeEvent
//  11.  user overrides            → buildUserOverrideEvent
//  12.  paper trades              → buildPaperTradeEvent
//  13.  simulated trades          → buildSimulatedTradeEvent
// ═══════════════════════════════════════════════════════════════════════════

export type VaultSeverity = "INFO" | "WARN" | "DANGER" | "CRITICAL";

export type VaultSource =
  | "CONTROL_TOWER"
  | "RISK_GOVERNOR"
  | "KILL_SWITCH"
  | "RESILIENCE"
  | "USER"
  | "MT5"
  | "STRATEGY"
  | "EXECUTION"
  | "VAULT";

export type VaultTruthDomain =
  | "SAFETY"
  | "MARKET"
  | "DECISION"
  | "EXECUTION"
  | "BEHAVIOR"
  | "OUTCOME";

export type VaultEventKind =
  // ── Phase 1 carry-overs (already in use) ─────────────────────────
  | "MODE_CHANGE"
  | "MODE_CHANGE_BLOCKED"
  | "KILL_SWITCH"
  | "KILL_SWITCH_RESET"
  | "KILL_SWITCH_RESET_REJECTED"
  | "STATE_TRANSITION"
  | "TRADE_GATE"
  // ── Phase 2 additions ────────────────────────────────────────────
  | "APPROVED_TRADE"
  | "BLOCKED_TRADE"
  | "REJECTED_TRADE"
  | "PAPER_TRADE"
  | "SIMULATED_TRADE"
  | "RISK_DECISION"
  | "RECOVERY_EVENT"
  | "MT5_DISCONNECT"
  | "LATENCY_SPIKE"
  | "SPREAD_CHANGE"
  | "USER_OVERRIDE";

export interface VaultEventInput {
  kind: VaultEventKind;
  severity: VaultSeverity;
  source: VaultSource;
  truthDomain: VaultTruthDomain;
  summary: string;
  payload?: Record<string, unknown>;
  reasons?: string[];
  blockers?: string[];
  operationalMode?: string;
  globalState?: string;
  symbol?: string;
  linkedTradeId?: string;
  linkedSignalId?: string;
  linkedDecisionId?: string;
  generatedAtIso: string;
}

// ── Common context shared by every builder ────────────────────────────────
export interface SystemSnapshot {
  operationalMode: string;
  globalState: string;
  generatedAtIso: string;
}

// ── 1. Mode change ────────────────────────────────────────────────────────
export interface ModeChangeArgs extends SystemSnapshot {
  fromMode: string;
  toMode: string;
  changedBy: string;
  accepted: boolean;
  reasons?: string[];
  blockers?: string[];
}
export function buildModeChangeEvent(a: ModeChangeArgs): VaultEventInput {
  return {
    kind: a.accepted ? "MODE_CHANGE" : "MODE_CHANGE_BLOCKED",
    severity: a.accepted ? "INFO" : "WARN",
    source: "CONTROL_TOWER",
    truthDomain: a.accepted ? "SAFETY" : "DECISION",
    summary: a.accepted
      ? `mode change ${a.fromMode} → ${a.toMode} by ${a.changedBy}`
      : `mode change to ${a.toMode} BLOCKED for ${a.changedBy}`,
    payload: { fromMode: a.fromMode, toMode: a.toMode, changedBy: a.changedBy },
    reasons: a.reasons,
    blockers: a.blockers,
    operationalMode: a.toMode,
    globalState: a.globalState,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 2. Blocked trade (route-level summary, complements TRADE_GATE detail) ─
export interface BlockedTradeArgs extends SystemSnapshot {
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;
  signalId?: string;
  reasons: string[];
  blockers: string[];
}
export function buildBlockedTradeEvent(a: BlockedTradeArgs): VaultEventInput {
  return {
    kind: "BLOCKED_TRADE",
    severity: "WARN",
    source: "RISK_GOVERNOR",
    truthDomain: "DECISION",
    summary: `BLOCKED ${a.direction} ${a.symbol} ${a.lot} (${a.strategy}, conf ${a.confidence})`,
    payload: { symbol: a.symbol, direction: a.direction, lot: a.lot, strategy: a.strategy, confidence: a.confidence },
    reasons: a.reasons,
    blockers: a.blockers,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    linkedSignalId: a.signalId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 3. Approved (LIVE) trade ───────────────────────────────────────────────
export interface ApprovedTradeArgs extends SystemSnapshot {
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;
  tradeId: string;
  decisionId?: string;
  signalId?: string;
}
export function buildApprovedTradeEvent(a: ApprovedTradeArgs): VaultEventInput {
  return {
    kind: "APPROVED_TRADE",
    severity: "INFO",
    source: "CONTROL_TOWER",
    truthDomain: "EXECUTION",
    summary: `APPROVED ${a.direction} ${a.symbol} ${a.lot} (${a.strategy}, conf ${a.confidence}) → trade ${a.tradeId}`,
    payload: { symbol: a.symbol, direction: a.direction, lot: a.lot, strategy: a.strategy, confidence: a.confidence },
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    linkedTradeId: a.tradeId,
    linkedDecisionId: a.decisionId,
    linkedSignalId: a.signalId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 4. Rejected trade (e.g. failed validation post-approval) ──────────────
export interface RejectedTradeArgs extends SystemSnapshot {
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;
  signalId?: string;
  reasons: string[];
  blockers: string[];
}
export function buildRejectedTradeEvent(a: RejectedTradeArgs): VaultEventInput {
  return {
    kind: "REJECTED_TRADE",
    severity: "WARN",
    source: "EXECUTION",
    truthDomain: "EXECUTION",
    summary: `REJECTED ${a.direction} ${a.symbol} ${a.lot} (${a.strategy}, conf ${a.confidence})`,
    payload: { symbol: a.symbol, direction: a.direction, lot: a.lot, strategy: a.strategy, confidence: a.confidence },
    reasons: a.reasons,
    blockers: a.blockers,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    linkedSignalId: a.signalId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 5. Risk decision (Risk Governor verdict line) ──────────────────────────
export interface RiskDecisionArgs extends SystemSnapshot {
  symbol: string;
  decision: "APPROVED" | "REDUCE_ONLY" | "HARD_BLOCK";
  composite01: number;
  reasons: string[];
  blockers: string[];
  signalId?: string;
}
export function buildRiskDecisionEvent(a: RiskDecisionArgs): VaultEventInput {
  return {
    kind: "RISK_DECISION",
    severity: a.decision === "HARD_BLOCK" ? "WARN" : "INFO",
    source: "RISK_GOVERNOR",
    truthDomain: "DECISION",
    summary: `risk ${a.decision} ${a.symbol} composite=${a.composite01.toFixed(2)}`,
    payload: { symbol: a.symbol, decision: a.decision, composite01: a.composite01 },
    reasons: a.reasons,
    blockers: a.blockers,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    linkedSignalId: a.signalId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 6. Kill switch events (engaged / reset) ───────────────────────────────
export interface KillSwitchEngagedArgs extends SystemSnapshot {
  reason: string;
  triggeredBy: string;
}
export function buildKillSwitchEngagedEvent(a: KillSwitchEngagedArgs): VaultEventInput {
  return {
    kind: "KILL_SWITCH",
    severity: "CRITICAL",
    source: "KILL_SWITCH",
    truthDomain: "SAFETY",
    summary: `kill switch engaged by ${a.triggeredBy}: ${a.reason}`,
    payload: { reason: a.reason, triggeredBy: a.triggeredBy },
    reasons: [a.reason],
    blockers: ["all trading halted"],
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    generatedAtIso: a.generatedAtIso,
  };
}
export interface KillSwitchResetArgs extends SystemSnapshot {
  resetBy: string;
  accepted: boolean;
  reasons?: string[];
  blockers?: string[];
}
export function buildKillSwitchResetEvent(a: KillSwitchResetArgs): VaultEventInput {
  return {
    kind: a.accepted ? "KILL_SWITCH_RESET" : "KILL_SWITCH_RESET_REJECTED",
    severity: a.accepted ? "WARN" : "DANGER",
    source: "KILL_SWITCH",
    truthDomain: "SAFETY",
    summary: a.accepted
      ? `kill switch reset by ${a.resetBy} → RECOVERY_MODE`
      : `kill switch reset REJECTED for ${a.resetBy}`,
    payload: { resetBy: a.resetBy, accepted: a.accepted },
    reasons: a.reasons,
    blockers: a.blockers,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 7. Recovery mode events ───────────────────────────────────────────────
export interface RecoveryEventArgs extends SystemSnapshot {
  trigger: string;
  detail?: string;
}
export function buildRecoveryEvent(a: RecoveryEventArgs): VaultEventInput {
  return {
    kind: "RECOVERY_EVENT",
    severity: "WARN",
    source: "CONTROL_TOWER",
    truthDomain: "SAFETY",
    summary: `recovery: ${a.trigger}${a.detail ? ` — ${a.detail}` : ""}`,
    payload: { trigger: a.trigger, detail: a.detail },
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 8. MT5 disconnect ─────────────────────────────────────────────────────
export interface Mt5DisconnectArgs extends SystemSnapshot {
  ageSeconds: number;
  link: "DEGRADED" | "DOWN";
}
export function buildMt5DisconnectEvent(a: Mt5DisconnectArgs): VaultEventInput {
  return {
    kind: "MT5_DISCONNECT",
    severity: a.link === "DOWN" ? "CRITICAL" : "WARN",
    source: "MT5",
    truthDomain: "SAFETY",
    summary: `MT5 link ${a.link} — heartbeat ${a.ageSeconds.toFixed(0)}s old`,
    payload: { ageSeconds: a.ageSeconds, link: a.link },
    blockers: a.link === "DOWN" ? ["MT5 link DOWN — execution unsafe"] : [],
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 9. Latency spike ──────────────────────────────────────────────────────
export interface LatencySpikeArgs extends SystemSnapshot {
  symbol: string;
  observedMs: number;
  thresholdMs: number;
}
export function buildLatencySpikeEvent(a: LatencySpikeArgs): VaultEventInput {
  return {
    kind: "LATENCY_SPIKE",
    severity: a.observedMs >= a.thresholdMs * 2 ? "DANGER" : "WARN",
    source: "RESILIENCE",
    truthDomain: "MARKET",
    summary: `latency spike ${a.symbol}: ${a.observedMs.toFixed(0)}ms ≥ ${a.thresholdMs.toFixed(0)}ms`,
    payload: { observedMs: a.observedMs, thresholdMs: a.thresholdMs },
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 10. Spread change ─────────────────────────────────────────────────────
export interface SpreadChangeArgs extends SystemSnapshot {
  symbol: string;
  fromPips: number;
  toPips: number;
}
export function buildSpreadChangeEvent(a: SpreadChangeArgs): VaultEventInput {
  const widened = a.toPips > a.fromPips;
  return {
    kind: "SPREAD_CHANGE",
    severity: widened && a.toPips >= a.fromPips * 2 ? "WARN" : "INFO",
    source: "RESILIENCE",
    truthDomain: "MARKET",
    summary: `spread ${a.symbol} ${a.fromPips.toFixed(2)} → ${a.toPips.toFixed(2)} pips`,
    payload: { fromPips: a.fromPips, toPips: a.toPips, widened },
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 11. User override ─────────────────────────────────────────────────────
export interface UserOverrideArgs extends SystemSnapshot {
  user: string;
  action: string;
  targetTradeId?: string;
  targetDecisionId?: string;
  reasons?: string[];
}
export function buildUserOverrideEvent(a: UserOverrideArgs): VaultEventInput {
  return {
    kind: "USER_OVERRIDE",
    severity: "WARN",
    source: "USER",
    truthDomain: "BEHAVIOR",
    summary: `user override by ${a.user}: ${a.action}`,
    payload: { user: a.user, action: a.action },
    reasons: a.reasons,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    linkedTradeId: a.targetTradeId,
    linkedDecisionId: a.targetDecisionId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 12. Paper trade ───────────────────────────────────────────────────────
export interface PaperTradeArgs extends SystemSnapshot {
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;
  tradeId: string;
}
export function buildPaperTradeEvent(a: PaperTradeArgs): VaultEventInput {
  return {
    kind: "PAPER_TRADE",
    severity: "INFO",
    source: "EXECUTION",
    truthDomain: "EXECUTION",
    summary: `PAPER ${a.direction} ${a.symbol} ${a.lot} (${a.strategy}) → trade ${a.tradeId}`,
    payload: { symbol: a.symbol, direction: a.direction, lot: a.lot, strategy: a.strategy, confidence: a.confidence },
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    linkedTradeId: a.tradeId,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── 13. Simulated (signal-only) trade ─────────────────────────────────────
export interface SimulatedTradeArgs extends SystemSnapshot {
  symbol: string;
  direction: "BUY" | "SELL";
  lot: number;
  strategy: string;
  confidence: number;
  reasons?: string[];
}
export function buildSimulatedTradeEvent(a: SimulatedTradeArgs): VaultEventInput {
  return {
    kind: "SIMULATED_TRADE",
    severity: "INFO",
    source: "EXECUTION",
    truthDomain: "DECISION",
    summary: `SIMULATED ${a.direction} ${a.symbol} ${a.lot} (${a.strategy}) — signal-only`,
    payload: { symbol: a.symbol, direction: a.direction, lot: a.lot, strategy: a.strategy, confidence: a.confidence },
    reasons: a.reasons,
    operationalMode: a.operationalMode,
    globalState: a.globalState,
    symbol: a.symbol,
    generatedAtIso: a.generatedAtIso,
  };
}

// ── Adapter port: outer code passes one of these to persist events ────────
export interface VaultEventSinkPort {
  write(event: VaultEventInput): Promise<void>;
}

// Convenience: combine builder + sink. Pure shell; no IO of its own.
export async function logEvent(
  sink: VaultEventSinkPort,
  event: VaultEventInput,
): Promise<void> {
  await sink.write(event);
}
