import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Shared types for the layered agent-system architecture.
//
// Pipeline:  sensors → agents → debate → judge → governor → execution
//                                                              ↓
//                                               monitoring (post-entry)
//                                                              ↓
//                                                  audit (post-close)
//
// Every step writes into a DecisionRecord stored via DecisionStorePort.
// ═══════════════════════════════════════════════════════════════════════════

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

// ── Proposed setup ────────────────────────────────────────────────────────
export interface ProposedSetup {
  symbol: string;
  direction: TradeDirection;
  intendedEntryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  lotSize: number;
  proposedRiskPct: number;
  pipSize: number;
}

// ── Sensor observations (FACTS ONLY) ──────────────────────────────────────
//
// Sensors collect raw + minimally-derived facts about the world. Derived
// facts ("EMA confluence", "trend bias signed") are still facts — they
// describe what the market IS, not what the trade SHOULD do. Agents
// interpret these facts; sensors don't.
export interface MarketObservation {
  symbol: string;
  currentPrice: number;
  bid: number;
  ask: number;
  spreadPips: number;
  volatilityNow: number;
  sessionStress01: number;
  marketOpen: boolean;
  liquidityScore01: number;
  // Derived facts about price structure:
  trendBiasSigned: number;            // -1..+1 from longer-frame EMA stack
  momentumSigned: number;             // -1..+1 from short-frame ROC
  recentStructureBreak: TradeDirection | null;
  unsweptLiquiditySide: TradeDirection | null;
  pipsToNearestSwing: number;
  emaConfluence01: number;
  observedAt: string;
}

export interface AccountObservation {
  balance: number;
  equity: number;
  openTradesCount: number;
  drawdownPct: number;
  dailyPnLPct: number;
  observedAt: string;
}

export interface ExecutionObservation {
  brokerConnected: boolean;
  lastFillSlippagePips: number | null;
  recentRejectionRate01: number;
  observedAt: string;
}

export const EmotionalStateSchema = z.enum(["CALM", "FOCUSED", "CAUTIOUS", "FRUSTRATED", "TILT"]);
export type EmotionalState = z.infer<typeof EmotionalStateSchema>;

export interface BehaviorObservation {
  emotionalState: EmotionalState;
  consecutiveLosses: number;
  consecutiveWins: number;
  minutesSinceLastTrade: number | null;
  observedAt: string;
}

export const NewsSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type NewsSeverity = z.infer<typeof NewsSeveritySchema>;
export interface UpcomingNewsEvent {
  title: string;
  severity: NewsSeverity;
  minutesUntil: number;
  affectsSymbol: boolean;
}
export interface NewsObservation {
  upcomingEvents: UpcomingNewsEvent[];
  blackoutMinutesBeforeHigh: number;
  blackoutMinutesAfterHigh: number;
  observedAt: string;
}

// ── Policy context (limits + reference data, not collected by sensors) ───
export const SessionLabelSchema = z.enum(["ASIA", "LONDON", "NY", "OFF_HOURS"]);
export type SessionLabel = z.infer<typeof SessionLabelSchema>;

export interface PolicyContext {
  // Risk policy
  maxConcurrentTrades: number;
  maxDrawdownPct: number;
  dailyLossLimitPct: number;        // negative
  maxSingleTradeRiskPct: number;
  // Behavior policy
  cooldownMinutesAfterLoss: number;
  maxConsecutiveLossesBeforeBlock: number;
  // Execution policy
  maxSpreadPipsPolicy: number;
  minLiquidity01: number;
  slippagePipsBudget: number;
  // Quality reference data
  symbolPreferredSessions: SessionLabel[];
  currentSession: SessionLabel;
  volHistorical: { median: number; p10: number; p90: number } | null;
  historicalMatches: {
    matchCount: number;
    winRate01: number;
    averagePnlR: number;
    averageSimilarity01: number;
  };
  // Regime + system-health reference
  regime: {
    currentRegimeId: string;
    currentRegimeHealth01: number;
    regimeChangedRecently: boolean;
    regimeDriftSigma: number;
  };
  systemHealth: {
    recentDisagreementRate01: number;
    recentFalseVetoRate01: number;
    shadowSampleSize: number;
    recentManualOverrideCount: number;
    recentIgnoredExitWarningCount: number;
    recentEmergencyKillCount: number;
  };
}

// ── Aggregate snapshot consumed by all agents ────────────────────────────
export interface AgentSystemSnapshot {
  setup: ProposedSetup;
  market: MarketObservation;
  account: AccountObservation;
  execution: ExecutionObservation;
  behavior: BehaviorObservation;
  news: NewsObservation;
  policy: PolicyContext;
  now: Date;
}

// ── Agent verdict types ──────────────────────────────────────────────────
export const AgentCategorySchema = z.enum(["HARD_BLOCK", "DIRECTION", "QUALITY"]);
export type AgentCategory = z.infer<typeof AgentCategorySchema>;

interface BaseVerdict {
  agentId: string;
  agentName: string;
  reasons: string[];
  observedAt: string;
}
export interface HardBlockVerdict extends BaseVerdict {
  category: "HARD_BLOCK";
  vetoed: boolean;
  vetoReason: string | null;
}
export interface DirectionVerdict extends BaseVerdict {
  category: "DIRECTION";
  direction: TradeDirection | "ABSTAIN";
  conviction: number;       // 0..100
}
export interface QualityVerdict extends BaseVerdict {
  category: "QUALITY";
  qualityScore: number;     // 0..100
}
export type AgentVerdict = HardBlockVerdict | DirectionVerdict | QualityVerdict;

// ── Debate ───────────────────────────────────────────────────────────────
export interface DebateConflict {
  agentA: string;
  agentB: string;
  conflictKind: "DIRECTIONAL_OPPOSITE" | "QUALITY_DISPERSION" | "BLOCK_VS_PASS";
  description: string;
}
export interface DebateReport {
  conflicts: DebateConflict[];
  directionalAgreement01: number;       // 0..1
  qualityDispersion01: number;          // 0..1 — higher = wider spread
  reasons: string[];
}
export interface ConflictResolution {
  conflictKind: DebateConflict["conflictKind"];
  action: "DEFER_TO_HIGHER_CONVICTION" | "AVERAGE" | "ESCALATE_TO_GOVERNOR" | "ABORT";
  chosenAgentId: string | null;
  reasons: string[];
}

// ── Judge ────────────────────────────────────────────────────────────────
export const ProposedActionSchema = z.enum(["APPROVE", "APPROVE_REDUCED", "REJECT"]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export interface ProposedDecision {
  action: ProposedAction;
  direction: TradeDirection | null;
  confidence: number;                  // 0..100
  sizeMultiplier: number;              // 0.30..1.50
  rationale: string[];
  contributingAgentIds: string[];
}
export interface DecisionExplanation {
  headline: string;
  bullets: string[];
  cautionFlags: string[];
}

// ── Governor ─────────────────────────────────────────────────────────────
export const GovernorVerdictSchema = z.enum([
  "APPROVE_AS_IS", "OVERRIDE_REJECT", "OVERRIDE_REDUCE",
]);
export type GovernorVerdict = z.infer<typeof GovernorVerdictSchema>;

export interface HardBlockRule {
  ruleId: string;
  description: string;
  // Pure predicate — true == rule fires (block).
  evaluate: (snap: AgentSystemSnapshot) => { fired: boolean; reason: string | null };
}
export interface GovernorReview {
  verdict: GovernorVerdict;
  finalAction: ProposedAction;
  finalSizeMultiplier: number;
  hardBlocksTriggered: string[];      // ruleIds
  overrideReasons: string[];
  reasons: string[];
}

// ── Execution ────────────────────────────────────────────────────────────
export interface OrderSpec {
  clientOrderId: string;
  symbol: string;
  direction: TradeDirection;
  lotSize: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  slippagePipsBudget: number;
}
export interface RawExecutionResult {
  ok: boolean;
  brokerOrderId?: string;
  fillPrice?: number;
  fillTime?: string;
  errorCode?: string;
  errorMessage?: string;
}
export interface ExecutionPort {
  sendOrder(order: OrderSpec): Promise<RawExecutionResult>;
}
export const ExecutionStatusSchema = z.enum([
  "FILLED", "REJECTED_BY_BROKER", "PARTIAL", "ERROR", "NOT_SENT",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export interface ExecutionResult {
  status: ExecutionStatus;
  orderSpec: OrderSpec;
  brokerOrderId: string | null;
  fillPrice: number | null;
  fillSlippagePips: number | null;
  fillTime: string | null;
  reasons: string[];
  blockers: string[];
}
export interface FillReport {
  matchesRequested: boolean;
  pipsDeviation: number;
  withinSlippageBudget: boolean;
  reasons: string[];
}

// ── Monitoring (post-entry) ──────────────────────────────────────────────
export interface OpenTradeStatus {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  pipSize: number;
  ageSeconds: number;
  expectedHoldSeconds: number;
  unrealizedR: number;
  maxFavorableExcursionR: number;
  maxAdverseExcursionR: number;
  currentPrice: number;
  currentSpreadPips: number;
  spreadAtEntryPips: number;
  reEvaluatedConfidence: number | null;
  agentDirectionReversed: boolean;
}

export const HealthStatusSchema = z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export interface TradeHealthReport { score: number; status: HealthStatus; reasons: string[]; }

export interface ConfidenceDecayReport {
  decay: number;            // 0..100
  derivedConfidence: number;
  primaryDriver: "TIME" | "MAE" | "AGENT_REVERSAL" | "CONDITION_DRIFT" | "NONE";
  reasons: string[];
}

export const ExitWarningLevelSchema = z.enum(["NONE", "WATCH", "CONSIDER", "STRONG"]);
export type ExitWarningLevel = z.infer<typeof ExitWarningLevelSchema>;
export interface ExitWarningReport {
  level: ExitWarningLevel;
  urgency: number;          // 0..100
  triggers: string[];
  reasons: string[];
}

export interface MonitoringBundle {
  tradeId: string;
  health: TradeHealthReport;
  decay: ConfidenceDecayReport;
  exitWarning: ExitWarningReport;
  recommendedAction: "HOLD" | "WATCH" | "CONSIDER_EXIT" | "EXIT_NOW";
  reasons: string[];
}

// ── Audit (post-close) ───────────────────────────────────────────────────
export interface ClosedTradeOutcome {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  pnlR: number;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAIL_STOP" | "TIME_STOP" | "MANUAL_EXIT" | "EMERGENCY_KILL";
  closedAt: string;
}
export interface AgentGrade {
  agentId: string;
  agentName: string;
  category: AgentCategory;
  contribution: "RIGHT" | "WRONG" | "ABSTAINED" | "NEUTRAL";
  score: number;            // 0..100
  reasons: string[];
}
export interface AgentPerformanceReport {
  grades: AgentGrade[];
  topRight: string | null;
  topWrong: string | null;
  reasons: string[];
}
export interface SelfAuditReport {
  systemDisciplineScore: number;     // 0..100
  flags: string[];
  reasons: string[];
}
export interface RegimeMemoryUpdate {
  currentRegimeId: string;
  newHealth01: number;
  reasons: string[];
}
export interface AuditReport {
  tradeId: string;
  evaluatedAt: string;
  performance: AgentPerformanceReport;
  selfAudit: SelfAuditReport;
  regimeUpdate: RegimeMemoryUpdate;
}

// ── Decision Store (Port) ────────────────────────────────────────────────
//
// Every agent-system run produces a DecisionRecord. The store is a typed
// Port — caller injects an implementation (Postgres, in-memory, S3…).
export interface DecisionRecord {
  decisionId: string;
  recordedAt: string;
  snapshot: AgentSystemSnapshot;
  agentVerdicts: AgentVerdict[];
  debate: DebateReport;
  proposedDecision: ProposedDecision;
  explanation: DecisionExplanation;
  governorReview: GovernorReview;
  execution: ExecutionResult | null;
  monitoring: MonitoringBundle[];      // appended over the trade's life
  audit: AuditReport | null;           // filled on close
}

export interface DecisionStorePort {
  put(record: DecisionRecord): Promise<void>;
  appendMonitoring(decisionId: string, bundle: MonitoringBundle): Promise<void>;
  setAudit(decisionId: string, report: AuditReport): Promise<void>;
  get(decisionId: string): Promise<DecisionRecord | null>;
  list(filter?: { since?: Date; until?: Date; symbol?: string }): Promise<DecisionRecord[]>;
}

// ── Sensor Ports ─────────────────────────────────────────────────────────
export interface MarketDataPort {
  fetchMarket(symbol: string): Promise<Omit<MarketObservation, "observedAt">>;
}
export interface AccountPort {
  fetchAccount(): Promise<Omit<AccountObservation, "observedAt">>;
}
export interface ExecutionDiagnosticsPort {
  fetchDiagnostics(): Promise<Omit<ExecutionObservation, "observedAt">>;
}
export interface BehaviorPort {
  fetchBehavior(): Promise<Omit<BehaviorObservation, "observedAt">>;
}
export interface NewsPort {
  fetchUpcomingNews(symbol: string): Promise<Omit<NewsObservation, "observedAt">>;
}

// ── Thresholds — single source of truth ──────────────────────────────────
export const AGENT_SYSTEM_THRESHOLDS = {
  direction: {
    minConvictionToVote: 30,
    minAgreementForConsensus01: 0.60,
  },
  quality: {
    rejectBelowAvg: 30,
    reduceAtOrBelowAvg: 60,
    multiplierMin: 0.30,
    multiplierMax: 1.50,
  },
  monitoring: {
    healthCriticalBelow: 25,
    healthPoorBelow: 45,
    decayStrongAbove: 70,
    exitWarningStrongHealthBelow: 30,
    exitWarningStrongDecayAbove: 70,
  },
  execution: {
    spreadProhibitivePips: 25,
  },
} as const;
