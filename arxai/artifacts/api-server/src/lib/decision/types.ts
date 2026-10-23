// Phase UX7 — Trade Decision Orchestrator types.
//
// One central decision per open trade. Every field is decision support;
// nothing here ever triggers an order, modifies a stop, or closes a trade.

export type DecisionLabel =
  | "Hold"
  | "Hold but monitor"
  | "Healthy pullback"
  | "Continuation still valid"
  | "Protect profit"
  | "Review partial close"
  | "Review full close"
  | "Move stop review"
  | "Trail stop review"
  | "Exit risk rising"
  | "Trade invalidation near"
  | "Trade invalidated"
  | "No clear decision"
  | "Data insufficient";

export type DecisionAction =
  | "HOLD"
  | "WATCH_CLOSELY"
  | "SET_ALERT"
  | "REVIEW_MOVE_STOP"
  | "REVIEW_TRAIL_STOP"
  | "REVIEW_PARTIAL_CLOSE"
  | "REVIEW_FULL_CLOSE"
  | "WAIT_FOR_CONFIRMATION"
  | "NO_ACTION_DATA_INSUFFICIENT";

export type SuggestedButton =
  | "HOLD_AND_MONITOR"
  | "SET_ALERT"
  | "ASK_AI_WHY"
  | "REVIEW_MOVE_STOP"
  | "REVIEW_TRAIL_STOP"
  | "REVIEW_PARTIAL_CLOSE"
  | "REVIEW_CLOSE";

export interface DecisionDataQuality {
  hasIntelligence: boolean;
  hasExitPlan: boolean;
  hasMarketContext: boolean;
  marketContextQuality: "good" | "partial" | "insufficient" | "unavailable";
  freshnessMinutes: number | null;
  missing: string[];
}

export interface TradeDecision {
  decisionLabel: DecisionLabel;
  decisionAction: DecisionAction;
  confidenceScore: number | null;   // 0..100
  urgencyScore: number | null;      // 0..100
  riskScore: number | null;         // 0..100
  reasonSummary: string;            // 1-2 sentence top-line
  mainReason: string;               // one-sentence “because …”
  supportingReasons: string[];      // bullet evidence
  invalidationLevel: number | null;
  protectProfitLevel: number | null;
  continuationLevel: number | null;
  suggestedButton: SuggestedButton;
  requiresConfirmation: boolean;
  whatWouldChange: string[];        // “what would flip this decision”
  dataQuality: DecisionDataQuality;
  source: string;                   // "orchestrator"
}
