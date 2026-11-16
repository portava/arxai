// Chart Brain v2 — Task 2: shared market-understanding engine types.
//
// These TypeScript interfaces are the single source of truth for the engine
// output shapes and are mirrored exactly by the OpenAPI schemas (the route
// validates its response against the generated Zod). Every engine is
// deterministic and honest: when inputs are too poor, `populated` reads false
// and numeric fields are null — nothing is ever fabricated.

// ── Engine 1: setup lifecycle & decay ─────────────────────────────────────
export type ChartSetupStage =
  | "no_setup"
  | "idea_forming"
  | "watchlist"
  | "trigger"
  | "confirmation_needed"
  | "entry_valid"
  | "trade_active"
  | "management"
  | "exit"
  | "review"
  | "stale"
  | "invalid";

export type ChartTradeType = "scalp" | "intraday" | "structure" | "unknown";

export type ChartDirection = "bullish" | "bearish" | "ranging" | "mixed" | "unknown";

// ── Engine: trend / regime ────────────────────────────────────────────────
export type ChartRegime = "trending" | "ranging" | "volatile" | "quiet" | "unknown";

export interface ChartTrendRead {
  populated: boolean;
  direction: ChartDirection;
  regime: ChartRegime;
  strength: number | null; // 0-100
  slope: number | null; // raw SMA slope, sign carries direction
  higherTimeframeBias: ChartDirection;
  note: string;
}

// ── Engine 2: level personality & market memory ───────────────────────────
export type ChartLevelKind = "support" | "resistance";

export type ChartLevelPersonality =
  | "fresh"
  | "defended"
  | "weakening"
  | "broken"
  | "retest_pending"
  | "trap_zone"
  | "scalp_only"
  | "invalidated";

export interface ChartLevel {
  kind: ChartLevelKind;
  price: number;
  personality: ChartLevelPersonality;
  touchCount: number;
  rejectionCount: number;
  breakCount: number;
  retestCount: number;
  strengthScore: number; // 0-100
  weaknessScore: number; // 0-100
  trapScore: number; // 0-100
  distancePct: number | null; // signed distance from last close, % (null if unknown)
}

export interface ChartLevelsRead {
  populated: boolean;
  levels: ChartLevel[];
  nearestSupport: ChartLevel | null;
  nearestResistance: ChartLevel | null;
  eventsRemembered: number; // memory rows folded into the read
  note: string;
}

// ── Engine 3: candle intent & pressure ────────────────────────────────────
export type ChartCandleIntent =
  | "pushing"
  | "rejecting"
  | "trapping"
  | "exhausting"
  | "absorbing"
  | "continuing"
  | "breaking_structure"
  | "failing_to_break"
  | "noise";

export type ChartPressure = "buyers" | "sellers" | "balanced" | "unknown";

export interface ChartCandleSignal {
  offsetFromLatest: number; // 0 = latest closed bar, 1 = the one before, …
  intent: ChartCandleIntent;
  buyerScore: number; // 0-100
  sellerScore: number; // 0-100
  rejectionScore: number; // 0-100
  exhaustionScore: number; // 0-100
  continuationScore: number; // 0-100
  trapScore: number; // 0-100
  importanceScore: number; // 0-100
}

export interface ChartCandleIntentRead {
  populated: boolean;
  latestIntent: ChartCandleIntent;
  dominantPressure: ChartPressure;
  signals: ChartCandleSignal[];
  note: string;
}

// ── Engine 4: timeframe agreement ─────────────────────────────────────────
export type ChartTfBias = "bullish" | "bearish" | "ranging" | "mixed" | "unknown";

export interface ChartTimeframeBias {
  timeframe: string;
  bias: ChartTfBias;
  available: boolean;
  stale: boolean;
}

export interface ChartTimeframeAgreement {
  populated: boolean;
  agreementScore: number | null; // 0-100
  alignedDirection: ChartTfBias;
  scalpOnlyWarning: boolean;
  timeframes: ChartTimeframeBias[];
  computedAt: string | null; // ISO of last background compute, null if never
  note: string;
}

// ── Engine 5: evidence stack + contradiction detector ─────────────────────
export type ChartEvidenceDirection = "bullish" | "bearish" | "neutral" | "unknown";
export type ChartSeverity = "low" | "medium" | "high";

export interface ChartEvidenceItem {
  text: string;
  weight: number; // 0-100
  source: string; // engine that produced it
}

export interface ChartContradiction {
  text: string;
  severity: ChartSeverity;
}

export interface ChartEvidenceRead {
  populated: boolean;
  direction: ChartEvidenceDirection;
  evidenceFor: ChartEvidenceItem[];
  evidenceAgainst: ChartEvidenceItem[];
  contradictions: ChartContradiction[];
  note: string;
}

// ── Engine 6: trade readiness + quality label ─────────────────────────────
export type ChartQualityLabel = "A+" | "A" | "B" | "C" | "D" | "F" | "unrated";

export interface ChartReadinessGate {
  key: string;
  label: string;
  passed: boolean;
  score: number; // 0-100 contribution
  detail: string;
}

export interface ChartReadinessRead {
  populated: boolean;
  score: number | null; // 0-100
  quality: ChartQualityLabel;
  gates: ChartReadinessGate[];
  vetoed: boolean;
  vetoReason: string | null;
  note: string;
}
