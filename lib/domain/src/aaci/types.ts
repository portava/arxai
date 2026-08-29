// ── ARX Adaptive Cohesion Intelligence (AACI 2.0) — pure domain contract ─────
//
// AACI answers a single question: "are all ARX systems aligned, fresh, fast,
// safe, and trustworthy enough to TRUST this decision?" It sits ABOVE the
// existing safety stack as an additional ADVISORY layer.
//
// INVIOLABLE DESIGN (mirrors the Handshake System):
// - ADVISORY / OBSERVATIONAL ONLY. AACI is NEVER a new execution path. It never
//   bypasses or weakens the Risk Governor, the 16-gate Phase B live pipeline,
//   kill switches, allocation limits, per-user permissions, or audit logging.
//   AACI can only ADD caution, never remove an existing block.
// - Authority order is fixed and one-directional: Admin governance > funding /
//   allocation > kill switches > Risk Governor hard blocks > bridge/data health >
//   AACI cohesion > Ruby / Self-Trade intelligence > agent strategy.
// - FAIL-OPEN to honest UNKNOWN / empty. Missing inputs are labelled, never
//   fabricated. No sim / mock / placeholder values ever masquerade as truth.
// - Per-user isolation on every read. Admin-only diagnostic detail; regular
//   users see clean plain-English messaging (no backend / enum / queue wording).
//
// This file is pure types + enums. No IO, no DB, no HTTP.

// ── Handshake registry ──────────────────────────────────────────────────────

// The systems that can contribute a handshake to an AACI decision.
export const AACI_HANDSHAKE_SYSTEMS = [
  "Ruby",
  "Scanner",
  "SmartChart",
  "MarketTimingBrain",
  "EconomicCalendar",
  "RiskGovernor",
  "SelfTradeAI",
  "SelfTradeSupervisor",
  "MT5Bridge",
  "OpenTrades",
  "MyAlerts",
  "AccountAnalytics",
  "WinsLosses",
  "AgentLedger",
  "AuditLog",
  "Permissions",
  "ExecutionRoute",
  "DataFreshness",
] as const;
export type AaciHandshakeSystem = (typeof AACI_HANDSHAKE_SYSTEMS)[number];

// Per-system handshake verdict.
// PASS    — signal present, fresh, healthy.
// WARN    — reachable but impaired (degraded / stale-ish / low confidence).
// FAIL    — definitive bad state (advisory "do not proceed" hint, never a gate).
// STALE   — reachable but the underlying signal is too old to trust.
// MISSING — the system could not be read / is not configured (honest unknown).
export const AACI_HANDSHAKE_STATUSES = ["PASS", "WARN", "FAIL", "STALE", "MISSING"] as const;
export type AaciHandshakeStatus = (typeof AACI_HANDSHAKE_STATUSES)[number];

export interface AaciHandshake {
  system: AaciHandshakeSystem;
  status: AaciHandshakeStatus;
  // 0–100 confidence/health contribution from this system.
  score: number;
  // Operator-facing detail (admin monitor only; may name systems/reasons).
  message: string;
  // ISO timestamp of the underlying signal, when known.
  lastUpdated?: string;
  // Measured latency of this system's read in ms, when known.
  latencyMs?: number;
  // Whether this handshake is required for the current action's HARD_GATE.
  required: boolean;
}

// ── Shared Truth Snapshot ───────────────────────────────────────────────────

export type AaciAccountMode = "live" | "demo" | "unknown";
export type AaciAccountRoute = "shared_mt5" | "user_mt5" | "unknown";
export type AaciBridgeStatus = "connected" | "unavailable" | "stale" | "unknown";
export type AaciDirectionalBias = "buy" | "sell" | "neutral" | "mixed";
export type AaciChartBias = "bullish" | "bearish" | "neutral" | "mixed";
export type AaciNewsRiskLevel = "low" | "medium" | "high" | "critical" | "unknown";

// A normalized snapshot of the current trusted state across major systems.
// Every AACI scoring function reads from THIS object — modules must not compute
// decision truth from isolated state once the snapshot exists. Optional fields
// default to honest-unknown (absent) rather than fabricated values.
export interface AaciSharedTruthSnapshot {
  snapshotId: string;
  timestamp: string;

  user: {
    userId: string;
    role: "admin" | "user" | string;
    isApproved?: boolean;
    canTrade?: boolean;
  };

  symbolContext: {
    selectedSymbol?: string;
    selectedTimeframe?: string;
    executionSymbol?: string;
    scannerSymbol?: string;
    chartSymbol?: string;
    rubySymbol?: string;
  };

  account: {
    mode?: AaciAccountMode;
    route?: AaciAccountRoute;
    balance?: number;
    equity?: number;
    openPl?: number;
    freeMargin?: number;
    marginLevel?: number;
    allocation?: number;
    lastUpdated?: string;
  };

  bridge: {
    status: AaciBridgeStatus;
    heartbeatAgeMs?: number;
    lastHeartbeat?: string;
    executionRouteReady?: boolean;
  };

  positions: {
    openCount: number;
    mt5OpenCount?: number;
    appOpenCount?: number;
    mismatch?: boolean;
    lastUpdated?: string;
  };

  scanner?: {
    bias?: AaciDirectionalBias;
    score?: number;
    lastUpdated?: string;
  };

  smartChart?: {
    bias?: AaciChartBias;
    structureScore?: number;
    lastCandleTime?: string;
    lastUpdated?: string;
  };

  ruby?: {
    bias?: AaciDirectionalBias;
    confidence?: number;
    explanationReady?: boolean;
    lastUpdated?: string;
  };

  heat?: {
    heatScore?: number;
    tradeabilityScore?: number;
    entryPermission?: string;
    bestAction?: string;
    moveStage?: string;
    lastUpdated?: string;
  };

  news?: {
    riskLevel?: AaciNewsRiskLevel;
    phase?: string;
    nextEventTime?: string;
    affectedSymbols?: string[];
    lastUpdated?: string;
  };

  risk?: {
    hardPass?: boolean;
    riskMode?: string;
    dailyLossHit?: boolean;
    weeklyLossHit?: boolean;
    drawdownLimitHit?: boolean;
    marginHealth?: number;
    lastUpdated?: string;
  };

  selfTradeAgent?: {
    agentId?: string;
    agentName?: string;
    funded?: boolean;
    active?: boolean;
    autonomyLevel?: number;
    quotaProgress?: string;
    ledgerHealthy?: boolean;
  };

  alerts?: {
    pipelineReady?: boolean;
    unreadCount?: number;
    lastUpdated?: string;
  };

  audit?: {
    auditReady?: boolean;
    lastDecisionId?: string;
  };

  /**
   * Phase 4 — Chart Handshake. 10-field PASS/WARN/FAIL summary from the Phase 3
   * Chart Truth gate. Present when a symbol was provided to buildAaciSnapshot and
   * the chart intelligence cache had a live entry. ADVISORY ONLY: a FAIL here
   * lowers market-truth confidence but never blocks the 16-gate live pipeline.
   */
  chartHandshake?: {
    ChartSource: "PASS" | "WARN" | "FAIL";
    OHLCIntegrity: "PASS" | "WARN" | "FAIL";
    TimeframeAccuracy: "PASS" | "WARN" | "FAIL";
    MirrorSync: "PASS" | "WARN" | "FAIL";
    FeedFreshness: "PASS" | "WARN" | "FAIL";
    HistoricalLiveMerge: "PASS" | "WARN" | "FAIL";
    BrokerPriceAlignment: "PASS" | "WARN" | "FAIL";
    RenderHealth: "PASS" | "WARN" | "FAIL";
    RubyReadAllowed: "PASS" | "WARN" | "FAIL";
    SelfTradeChartAllowed: "PASS" | "WARN" | "FAIL";
    overall: "PASS" | "WARN" | "FAIL";
    chartTruthScore: number;
    chartReadScore: number;
    primaryBlockReason: string | null;
  };

  // Honest-unknown markers: systems that could not be read this cycle. Surfaced
  // to admin diagnostics and folded into Data Quality / Lineage Trust.
  unavailableSystems?: AaciHandshakeSystem[];
}

// ── Hard gate ───────────────────────────────────────────────────────────────

// The binary factors of the HARD_GATE. Each is true (pass) or false (block).
// Unknown inputs MUST resolve to a conservative value chosen by the composer
// (fail-open advisory means UNKNOWN should not silently PASS a live gate).
export interface AaciHardGateFactors {
  // Security handshake (AACI Security Phase 2). True only when the per-action
  // security handshake was POSITIVELY verified. ADVISORY: it can only ADD a
  // block — it never relaxes any other factor or the downstream 16-gate
  // pipeline. Defaults closed (false) for unevaluable/sensitive callers.
  securityHandshakePass: boolean;
  permission: boolean;
  funded: boolean;
  active: boolean;
  autonomyAllowed: boolean;
  riskPass: boolean;
  lossLimitPass: boolean;
  bridgeReady: boolean;
  feedFresh: boolean;
  symbolTradable: boolean;
  allocationAvailable: boolean;
  executionRouteReady: boolean;
  auditReady: boolean;
}

// Clean reason code + plain-English message for a failed hard-gate factor.
export interface AaciHardGateFailure {
  // Stable machine code (admin/diagnostic only), e.g. "BRIDGE_NOT_READY".
  code: string;
  // Plain-English message safe to show a regular user (no backend wording).
  userMessage: string;
}

export interface AaciHardGateResult {
  // H — 1 when every required factor passes, else 0.
  pass: boolean;
  value: 0 | 1;
  failures: AaciHardGateFailure[];
}

// ── Conflict + freshness + latency records ──────────────────────────────────

export const AACI_CONFLICT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AaciConflictSeverity = (typeof AACI_CONFLICT_SEVERITIES)[number];

export interface AaciConflict {
  // Stable machine code, e.g. "SCANNER_CHART_DISAGREE", "POSITION_SYNC_MISMATCH".
  code: string;
  severity: AaciConflictSeverity;
  // The systems in disagreement.
  systems: AaciHandshakeSystem[];
  // Operator-facing description (admin diagnostics).
  detail: string;
}

export interface AaciFreshnessRecord {
  // Logical source name, e.g. "marketFeed", "bridgeHeartbeat", "scanner".
  source: string;
  // Age of the source signal in ms (null = unknown / not time-based).
  ageMs: number | null;
  // Staleness threshold in ms applied to this source.
  thresholdMs: number;
  // 0–100 freshness score for this source.
  score: number;
  // True when ageMs exceeds thresholdMs (or the source is unknown/critical).
  stale: boolean;
}

export interface AaciLatencyRecord {
  // Benchmark name, e.g. "riskCheck", "mt5RoundTrip", "scannerRefresh".
  benchmark: string;
  // Measured latency in ms.
  latencyMs: number;
  // Target/budget latency in ms for this benchmark.
  budgetMs: number;
  // ISO timestamp the sample was recorded.
  recordedAt: string;
}

// ── Edge decay / speed states ───────────────────────────────────────────────

// Strategy families with distinct edge half-lives (how fast a signal's edge
// decays). Used by EdgeDecay = e^(-signalAge / halfLife).
export const AACI_STRATEGY_KINDS = [
  "flame_scalp",
  "fast_scalp",
  "m5_pullback",
  "m15_setup",
  "swing",
  "news_first_reaction",
  "post_news_confirmation",
] as const;
export type AaciStrategyKind = (typeof AACI_STRATEGY_KINDS)[number];

export const AACI_SPEED_STATES = [
  "EARLY",
  "ON_TIME",
  "DECAYING",
  "LATE",
  "EXPIRED",
  "TOO_SLOW_TO_EXECUTE",
] as const;
export type AaciSpeedState = (typeof AACI_SPEED_STATES)[number];

export interface AaciEdgeDecayResult {
  // e^(-signalAge / halfLife), clamped 0–1.
  edgeDecay: number;
  // The half-life (ms) used for the strategy.
  halfLifeMs: number;
  // Signal age (ms) used.
  signalAgeMs: number;
  speedState: AaciSpeedState;
}

// ── Score breakdown ─────────────────────────────────────────────────────────

// All component sub-scores (0–100) and multiplicative validity factors (0–1)
// that feed the master AACI formula.
export interface AaciScoreBreakdown {
  // Component sub-scores (0–100).
  dataFreshnessScore: number; // F
  graphCohesionScore: number; // G
  riskAlignmentScore: number; // R
  marketTruthScore: number; // M
  speedLatencyScore: number; // S
  executionReadinessScore: number; // E
  driftScore: number; // D
  auditAlertReadinessScore: number; // A
  learnedTrustScore: number; // L
  dataQualityScore: number; // Q
  uiConsistencyScore: number; // U
  explainabilityScore: number; // X
  // Penalty term P (0–1 fraction subtracted from the weighted cohesion input).
  penalty: number; // P

  // Multiplicative validity factors (0–1).
  speedValidity: number; // SPEED_VALIDITY (edge decay × execution-speed confidence)
  uncertaintyConfidence: number; // UNCERTAINTY_CONFIDENCE
  dataLineageTrust: number; // DATA_LINEAGE_TRUST
  selfLearningIntegrity: number; // SELF_LEARNING_INTEGRITY
}

// ── Decision object ─────────────────────────────────────────────────────────

export const AACI_ACTOR_TYPES = ["user", "ruby", "self_trade_agent", "admin", "system"] as const;
export type AaciActorType = (typeof AACI_ACTOR_TYPES)[number];

export const AACI_RECOMMENDED_ACTIONS = [
  "ALLOW",
  "ALLOW_REDUCED_SIZE",
  "PREPARE_ONLY",
  "WAIT_FOR_CONFIRMATION",
  "WATCH_ONLY",
  "PROTECT_OPEN_TRADE",
  "EXIT_OR_REDUCE",
  "RECONCILE_SYSTEM",
  "BLOCK",
  "ALERT_ADMIN",
] as const;
export type AaciRecommendedAction = (typeof AACI_RECOMMENDED_ACTIONS)[number];

export interface AaciDecision {
  decisionId: string;
  timestamp: string;

  actorType: AaciActorType;
  actorId?: string;

  symbol?: string;
  timeframe?: string;
  actionRequested: string;

  hardGatePass: boolean;
  hardGateFailures: string[];

  // Component sub-scores (0–100).
  dataFreshnessScore: number;
  graphCohesionScore: number;
  riskAlignmentScore: number;
  marketTruthScore: number;
  speedLatencyScore: number;
  executionReadinessScore: number;
  driftScore: number;
  auditAlertReadinessScore: number;
  learnedTrustScore: number;
  dataQualityScore: number;
  uiConsistencyScore: number;
  explainabilityScore: number;

  // Multiplicative validity factors (0–1).
  speedValidity: number;
  uncertaintyConfidence: number;
  dataLineageTrust: number;
  selfLearningIntegrity: number;

  // Final AACI score (0–100) via the master formula.
  finalAaciScore: number;

  recommendedAction: AaciRecommendedAction;

  // Operator-facing explanation (admin diagnostics; may name systems/reasons).
  explanation: string;
  // Clean plain-English explanation safe for regular users.
  userFacingExplanation: string;
  systemConflicts: string[];
  staleInputs: string[];
  requiredFollowUps: string[];

  handshakes: AaciHandshake[];

  createdAuditEvent: boolean;
  alertCreated?: boolean;

  /** JOURNAL-ONLY value-of-information advisory for WAIT-capable decisions
   *  (see valueOfInformation.ts). Never changes recommendedAction or any gate;
   *  absent when the decision is not WAIT-capable. Uses the unknown-shaped
   *  record here to keep the decision payload schema additive. */
  voiAdvisory?: Record<string, unknown>;
}
