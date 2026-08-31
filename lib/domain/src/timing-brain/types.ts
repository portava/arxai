// Ruby Market Timing Brain — shared domain types.
//
// These types are the contract consumed by every engine, route, and future
// phase. They must remain pure (no IO, no side-effects) and are the single
// source of truth for what a timing read contains.

// ── Scores (0-100) ────────────────────────────────────────────────────────

/** 0-100. How much price movement energy is present right now. */
export type HeatScore = number;

/** 0-100. Whether the current conditions support taking a trade. Independent of heat. */
export type TradeabilityScore = number;

/** 0-100. Quality/cleanliness of the edge. High = clean structure + momentum. */
export type EdgeScore = number;

/** 0-100. Composite danger — news window, trap risk, exhaustion, false heat. */
export type DangerScore = number;

/** 0-100. Probability the current move is a trap/fakeout. */
export type TrapProbability = number;

/** 0-100. How much room price has to move before hitting a liquidity barrier. */
export type RoomToMove = number;

/** 0-100. Buy-side pressure. */
export type BuyPressure = number;

/** 0-100. Sell-side pressure. */
export type SellPressure = number;

// ── Categorical states ────────────────────────────────────────────────────

export type TimingGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export type EntryPermission =
  | "GO"               // All checks pass — entry is permissible
  | "WAIT_FOR_ENTRY"   // Good conditions but price not at entry yet
  | "WAIT_NEWS"        // Hold off — news event in window
  | "NO_TRADE"         // Poor edge / chop / danger too high
  | "STAND_DOWN";      // Hard block — session closed, extreme danger, feed down

export type HeatState =
  | "CLEAN_MOMENTUM"     // Clear directional heat with structure backing
  | "DIRTY_HEAT"         // Movement but disorganised / spread-driven
  | "TRAP_HEAT"          // Looks hot but sweep/reversal pattern detected
  | "NEWS_HEAT"          // Heat is news-driven (not structural)
  | "EXHAUSTION_HEAT"    // Extended move, late-stage momentum
  | "FALSE_HEAT"         // Thin-liquidity / stale-feed artefact
  | "COMPRESSION"        // Volatility contracting — coiled spring
  | "WAKE_UP"            // Breaking out of compression — early heat
  | "COOL";              // Low heat / quiet market

export type MoveStage =
  | "EARLY"      // Potential move beginning — low extension
  | "DEVELOPING" // Move underway — room still exists
  | "MATURE"     // Well-extended — good portion of range consumed
  | "EXHAUSTED"  // At or beyond typical session range — reversal risk high

export type BestAction =
  | "BUY"
  | "SELL"
  | "WAIT_FOR_PULLBACK"
  | "WAIT_FOR_NEWS"
  | "WAIT_BETTER_TIMING"
  | "STAND_DOWN"
  | "WATCH_ONLY";

// ── Heat Source breakdown ─────────────────────────────────────────────────

export type HeatSourceKind =
  | "session_open"      // Session just opened — liquidity rush
  | "session_overlap"   // Two sessions active — peak liquidity
  | "volatility_atr"    // ATR-expansion relative to session baseline
  | "news_catalyst"     // Economic event driving the move
  | "liquidity_sweep"   // Stop-hunt / sweep pattern detected
  | "structural_break"  // BOS / displacement candle
  | "compression_break" // Breakout from tight range
  | "trend_continuation"// Sustained directional EMA/price momentum
  | "unknown";          // Fallback when insufficient data

export interface HeatSourceBreakdown {
  primary: HeatSourceKind;
  primaryConfidence: number; // 0-100
  backup: HeatSourceKind | null;
  backupConfidence: number | null;
  explanation: string; // Human-readable one-liner
}

// ── News phase ────────────────────────────────────────────────────────────

export type NewsPhase =
  | "PRE_EVENT"   // Within avoid-before window
  | "AT_EVENT"    // Inside release window
  | "POST_EVENT"  // Inside avoid-after window
  | "SETTLED"     // Event passed, volatility subsiding
  | "NONE";       // No relevant events in window

export interface NewsOverlay {
  phase: NewsPhase;
  eventName: string | null;
  minutesUntil: number | null;
  minutesSince: number | null;
  eventType: "high_impact" | "medium_impact" | "low_impact" | "none";
  surpriseScore: number | null; // null when no actual result yet
  heatAdjustment: number; // −100..+100 additive delta to heat score
  blocksTrade: boolean;
}

// ── Broad market flow ─────────────────────────────────────────────────────

export type BroadFlowVerdict =
  | "ALIGNED"          // Correlated assets confirm the move direction
  | "CONFLICTED"       // Mixed signals across correlated assets
  | "NEUTRAL"          // No strong cross-asset signal
  | "OPPOSING"         // Correlated assets moving against
  | "UNAVAILABLE";     // Provider not configured — honest empty

export interface BroadFlowResult {
  verdict: BroadFlowVerdict;
  institutionalFlowScore: number; // 0-100
  competingCatalyst: boolean;
  description: string;
  correlatedAssets: Array<{
    symbol: string;
    direction: "BULL" | "BEAR" | "FLAT";
    contribution: "CONFIRMS" | "CONFLICTS" | "NEUTRAL";
  }>;
  dataQuality: "real" | "partial" | "unavailable";
}

// ── Session / Kill-Zone result ────────────────────────────────────────────

export type KillZone =
  | "LONDON_OPEN"        // 07:00-08:30 UTC
  | "NY_OPEN"            // 12:00-13:30 UTC
  | "LONDON_NY_OVERLAP"  // 13:00-17:00 UTC
  | "ASIAN_KILLZONE"     // 00:00-02:30 UTC
  | "LONDON_CLOSE"       // 14:00-16:00 UTC
  | "OFF_KILLZONE";      // Outside all kill zones

export interface SessionTimingResult {
  sessionName: string;
  killZone: KillZone;
  isKillZoneActive: boolean;
  utcHour: number;
  sessionHeatBonus: number;   // 0-30 additive bonus to heat
  fakeoutRisk: number;        // 0-100
  tradeabilityBonus: number;  // 0-25 additive bonus to tradeability
  bestSymbols: string[];
  dangerSymbols: string[];    // Symbols with session-specific risk
  sessionDescription: string;
  userLocalTime: string | null; // ISO string if tz available, null otherwise
}

// ── Data quality / honesty marker ─────────────────────────────────────────

export type DataQualityLabel =
  | "real"                  // All scores derived from live provider data
  | "basic_timing_estimate" // Legacy session+clock-only label — no longer emitted by the composer (a fully-down feed is "unavailable"); kept for stored heat snapshots
  | "partial"               // Some real data, some estimated
  | "unavailable";          // No candle AND no quote data — no meaningful read; UIs collapse instead of rendering clock-derived scores

export interface TimingDataQuality {
  label: DataQualityLabel;
  hasCandleData: boolean;
  hasQuoteData: boolean;
  hasNewsData: boolean;
  hasBroadFlowData: boolean;
  note: string; // Honest description of what data was used
}

// ── Master timing read ────────────────────────────────────────────────────

/**
 * The single structured output of `marketTimingBrainService`. Every field is
 * either a real computed value or an explicit "unavailable" marker — nothing
 * is fabricated. Consumers (Heat Map page, Scanner, Risk Governor, etc.)
 * must check `dataQuality.label` before treating scores as actionable.
 */
export interface MarketTimingRead {
  symbol: string;
  timeframe: string;
  generatedAt: string; // ISO timestamp

  // Core scores (all 0-100)
  heatScore: HeatScore;
  tradeabilityScore: TradeabilityScore;
  edgeScore: EdgeScore;
  dangerScore: DangerScore;
  trapProbability: TrapProbability;
  roomToMove: RoomToMove;

  // Side pressure
  buyPressure: BuyPressure;
  sellPressure: SellPressure;
  pressureBias: "BUY" | "SELL" | "NEUTRAL";

  // Categorical
  timingGrade: TimingGrade;
  entryPermission: EntryPermission;
  heatState: HeatState;
  moveStage: MoveStage;

  // Breakdowns
  heatSource: HeatSourceBreakdown;
  session: SessionTimingResult;
  newsOverlay: NewsOverlay;
  broadFlow: BroadFlowResult;

  // Decision
  bestAction: BestAction;
  actionReason: string; // One clear sentence why

  // Honesty
  dataQuality: TimingDataQuality;
}
