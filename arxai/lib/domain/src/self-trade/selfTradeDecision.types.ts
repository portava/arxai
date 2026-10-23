// Self-Trade Decision Brain — shared types (Task #212).
//
// PURE / deterministic decision layer for the Self-Trade AI fleet. This is a
// SHADOW / decision-only pipeline: it produces ranked, supervisor-approved trade
// DECISIONS with a full thesis + ordered, auditable handshake checks. It NEVER
// places a real order (live execution is a later phase and still rides the
// existing 16-gate live pipeline, Risk Governor, allocation and kill switches).
//
// HONESTY CONTRACT: never fabricate a level, score, direction, or relationship.
// When data is missing / stale / too short the decision collapses to an honest
// WATCH / WAIT outcome with the missing context named — never a guessed trade.

import type {
  NewsRiskLevel,
  RubyMarketEdgeSignal,
} from "../signal-intelligence/signalIntelligence.types.js";

// ── Ordered, auditable check (one handshake step) ────────────────────────────

export type DecisionCheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface DecisionCheck {
  /** Stable machine key, e.g. "kill_switch", "data_feed", "setup". */
  key: string;
  /** Terse human label for the audit/UI. */
  label: string;
  status: DecisionCheckStatus;
  /** Factual one-line detail (never fabricated, never a secret). */
  detail: string;
  /** When true, a FAIL here hard-blocks any approval. */
  blocking: boolean;
}

// ── Supervisor outcome + conflict (mirror the DB enums in lib/db) ────────────

export type SelfTradeDecisionOutcome =
  | "APPROVED"
  | "APPROVED_REDUCED"
  | "PREPARE_ONLY"
  | "WATCH_ONLY"
  | "WAIT"
  | "DENIED"
  | "BLOCKED"
  | "ASSIGNED_TO_ANOTHER";

export type SelfTradeConflictState =
  | "NONE"
  | "DUPLICATE"
  | "SAME_SYMBOL_SAME_SIDE"
  | "SAME_SYMBOL_OPPOSITE"
  | "CORRELATED";

export type TradeSide = "BUY" | "SELL";

// ── Module verdicts ──────────────────────────────────────────────────────────

export interface RegimeFit {
  regime: string;
  /** True when the regime is workable for an entry (TRENDING/BREAKOUT/VOLATILE). */
  tradeable: boolean;
  /** 0–100 fit quality for taking a setup in this regime. */
  fitScore: number;
  note: string;
}

export type SetupKind =
  | "TREND_CONTINUATION"
  | "BREAKOUT_RETEST"
  | "REVERSAL"
  | "LIQUIDITY_SWEEP"
  | "RANGE_FADE"
  | "NONE";

export interface SetupClassification {
  setup: SetupKind;
  side: TradeSide | null;
  /** 0–100 setup quality. */
  score: number;
  reasons: string[];
}

export interface MtfAlignmentVerdict {
  aligned: boolean;
  /** 0–100 agreement across the supplied timeframes. */
  agreementScore: number;
  htfBias: string;
  ltfBias: string;
  conflict: boolean;
  note: string;
}

export type EntryZoneState = "AT_ENTRY" | "APPROACHING" | "FAR" | "NO_ZONE";

export interface EntryZoneVerdict {
  state: EntryZoneState;
  distancePct: number | null;
  note: string;
}

export interface LateEntryVerdict {
  isLate: boolean;
  doNotChase: boolean;
  reason: string | null;
}

export type SpreadVerdictStatus = "OK" | "WIDE" | "BLOCKED" | "UNKNOWN";

export interface SpreadSlippageVerdict {
  status: SpreadVerdictStatus;
  spreadPoints: number | null;
  maxSpreadPoints: number | null;
  note: string;
}

export interface NoTradeVerdict {
  /** 0–100 — how confident the brain is that NOT trading is correct now. */
  score: number;
  isNoTrade: boolean;
  reason: string | null;
}

export interface ConfidenceDecayVerdict {
  base: number;
  decayed: number;
  ageSeconds: number;
  validForSeconds: number;
  expired: boolean;
  note: string;
}

// ── Thesis (no thesis ⇒ no decision) ─────────────────────────────────────────

export interface TradeThesis {
  symbol: string;
  side: TradeSide;
  setup: SetupKind;
  /** Plain factual "why now" chain (never fabricated). */
  whyNow: string[];
  entryZone: { from: number; to: number } | null;
  stopLoss: number;
  invalidation: number | null;
  takeProfits: { from: number; to: number }[];
  /** Net tradeable edge 0–100 at thesis time. */
  edge: number;
  confidence: number;
  newsRisk: NewsRiskLevel;
}

// ── Score breakdown (audit transparency) ─────────────────────────────────────

export interface DecisionScoreBreakdown {
  direction: number;
  entry: number;
  execution: number;
  risk: number;
  newsSafety: number;
  timing: number;
  survivability: number;
  regimeFit: number;
  mtfAgreement: number;
  setup: number;
  overall: number;
  edge: number;
  noTrade: number;
  /** Composite rank used for ordering + one-owner-per-trade resolution. */
  rank: number;
}

// ── Quota / funding / governor / handshake context (plain shapes) ────────────

export interface QuotaContext {
  dailyMinTrades: number;
  effectiveMaxTrades: number;
  tradesTakenToday: number;
  remainingToMax: number;
  belowDailyMinimum: boolean;
  baseReached: boolean;
  hardCapReached: boolean;
}

export interface FundingContext {
  availableFunds: number;
  allocatedFunds: number;
}

export interface GovernorContext {
  /** PAPER_ALLOWED | PAPER_PAUSED | WATCH_ONLY | LOCKED | UNKNOWN. */
  status: string;
  hardBlocks: string[];
}

export interface HandshakeReadinessContext {
  ready: boolean;
  degraded: string[];
  blocked: string[];
}

export interface ExecutionContext {
  liveSpreadPoints: number | null;
  heartbeatAgeSeconds: number | null;
  bridgeConnected: boolean | null;
}

// ── Pipeline input + output ──────────────────────────────────────────────────

export interface DecisionCandidateInput {
  agentId: number;
  agentKey: string;
  /** Higher = preferred when two agents contend for the same trade. */
  agentRankWeight: number;
  symbol: string;
  timeframe: string;
  /** Whether the symbol is in this agent's configured allowlist. */
  symbolAllowed: boolean;
  /** Max spread (points) the agent will tolerate for this symbol, if configured. */
  maxSpreadPoints: number | null;
  /** Primary-timeframe normalized signal (real data or honest blind). */
  signal: RubyMarketEdgeSignal;
  /** Higher-timeframe signals for alignment (may be empty). */
  htfSignals: RubyMarketEdgeSignal[];
  currentPrice: number | null;
  newsRisk: NewsRiskLevel;
  execution: ExecutionContext;
  quota: QuotaContext;
  funding: FundingContext;
  governor: GovernorContext;
  handshake: HandshakeReadinessContext;
  killEngaged: boolean;
  /** Epoch ms; injected for deterministic tests. */
  now: number;
}

export interface DecisionCandidate {
  agentId: number;
  agentKey: string;
  agentRankWeight: number;
  symbol: string;
  timeframe: string;
  side: TradeSide | null;
  setup: SetupKind;
  outcome: SelfTradeDecisionOutcome;
  conflictState: SelfTradeConflictState;
  ownerAgentKey: string | null;
  plannedAction: string;
  reason: string;
  riskState: string;
  setupScore: number;
  rankScore: number;
  noTradeScore: number;
  confidence: number;
  confidenceDecayed: number;
  setupExpiresAt: string | null;
  checks: DecisionCheck[];
  scoreBreakdown: DecisionScoreBreakdown;
  thesis: TradeThesis | null;
  quotaProgress: QuotaContext;
}
