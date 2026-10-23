import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Conditional Execution
//
// Sits between an APPROVED setup and the actual order send. Each armed order
// carries a list of trigger conditions; the order fires only when the
// combinator (ALL / ANY) over the conditions is satisfied within the
// validity window.
//
// Each tick:
//   • re-evaluate every condition against current market state
//   • combinator decides FIRE / STILL_ARMED / INVALIDATED
//   • EXPIRED takes precedence when validity window has elapsed
//
// Conditions return a 3-state status:
//   • PENDING                — not yet satisfied; could still satisfy
//   • SATISFIED              — condition is met
//   • PERMANENTLY_IMPOSSIBLE — cannot be satisfied for THIS armed order
//                              (e.g. level broke, wrong-direction candle closed
//                              in NEXT mode). Triggers INVALIDATED.
// ═══════════════════════════════════════════════════════════════════════════

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

// ── Per-condition param shapes (discriminated by `kind`) ─────────────────
export const RetestHoldsParamsSchema = z.object({
  kind: z.literal("RETEST_HOLDS"),
  levelPrice: z.number(),
  levelLabel: z.string(),
  proximityPips: z.number().positive(),
  holdSeconds: z.number().positive(),
  // If price runs against the trade direction by more than this many pips
  // since first touch, condition is still PENDING (waiting for re-test).
  maxRejectPips: z.number().positive(),
  // If adverse excursion exceeds this, the level is considered broken —
  // condition becomes PERMANENTLY_IMPOSSIBLE.
  invalidationDistancePips: z.number().positive(),
});

export const SpreadBelowParamsSchema = z.object({
  kind: z.literal("SPREAD_BELOW"),
  maxSpreadPips: z.number().positive(),
});

export const CandleClosesParamsSchema = z.object({
  kind: z.literal("CANDLE_CLOSES"),
  direction: z.enum(["BULLISH", "BEARISH"]),
  minBodyPips: z.number().nonnegative(),
  // NEXT          — the FIRST candle that closes after arming must satisfy;
  //                 a wrong-direction close → PERMANENTLY_IMPOSSIBLE.
  // ANY_IN_WINDOW — any closed candle in the validity window may satisfy;
  //                 wrong closes are ignored, condition stays PENDING.
  mode: z.enum(["NEXT", "ANY_IN_WINDOW"]),
});

export const LiquiditySweepParamsSchema = z.object({
  kind: z.literal("LIQUIDITY_SWEEP"),
  // HIGH = pool sits ABOVE current price (sweep is an upward push then reversal).
  // LOW  = pool sits BELOW current price (sweep is a downward push then reversal).
  side: z.enum(["HIGH", "LOW"]),
  poolPrice: z.number(),
  minPenetrationPips: z.number().positive(),
  reversalPips: z.number().positive(),
  // If penetration exceeds this without reversal, treat as breakout (not sweep)
  // and mark PERMANENTLY_IMPOSSIBLE.
  invalidationPips: z.number().positive(),
});

export const ConditionParamsSchema = z.discriminatedUnion("kind", [
  RetestHoldsParamsSchema,
  SpreadBelowParamsSchema,
  CandleClosesParamsSchema,
  LiquiditySweepParamsSchema,
]);
export type ConditionParams = z.infer<typeof ConditionParamsSchema>;
export type ConditionKind = ConditionParams["kind"];

// ── Condition evaluation ─────────────────────────────────────────────────
export const ConditionStatusSchema = z.enum([
  "PENDING", "SATISFIED", "PERMANENTLY_IMPOSSIBLE",
]);
export type ConditionStatus = z.infer<typeof ConditionStatusSchema>;

export interface ConditionEvaluation {
  kind: ConditionKind;
  status: ConditionStatus;
  reasons: string[];
}

// ── Live state used by condition evaluators ──────────────────────────────
export interface MarketTick {
  currentPrice: number;
  bid: number;
  ask: number;
  spreadPips: number;
  observedAt: string;
}

export interface ClosedCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  openTime: string;
  closeTime: string;
  timeframe: string;
}

export interface EvaluationContext {
  symbol: string;
  pipSize: number;
  tradeDirection: TradeDirection;
  currentTick: MarketTick;
  // History since the order was armed — drives stateful conditions
  // (retest, sweep). Sensors are responsible for slicing this window.
  recentTicks: MarketTick[];
  recentClosedCandles: ClosedCandle[];
  armedAt: string;
  now: Date;
}

// ── Pending order shape (kept self-contained — no coupling to OrderSpec) ─
export interface PendingOrder {
  symbol: string;
  direction: TradeDirection;
  lotSize: number;
  intendedEntryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  slippagePipsBudget: number;
}

// ── Armed order ──────────────────────────────────────────────────────────
export const CombinatorSchema = z.enum(["ALL", "ANY"]);
export type Combinator = z.infer<typeof CombinatorSchema>;

export const ArmedOrderStatusSchema = z.enum([
  "ARMED", "FIRED", "EXPIRED", "INVALIDATED", "CANCELLED",
]);
export type ArmedOrderStatus = z.infer<typeof ArmedOrderStatusSchema>;

export interface ArmedOrder {
  armedOrderId: string;
  decisionId: string | null;          // links back to the source DecisionRecord
  pendingOrder: PendingOrder;
  conditions: ConditionParams[];
  combinator: Combinator;
  armedAt: string;
  expiresAt: string;
  status: ArmedOrderStatus;
}

// ── Per-tick evaluation result ───────────────────────────────────────────
export const TickActionSchema = z.enum([
  "STILL_ARMED", "FIRE", "EXPIRE", "INVALIDATE",
]);
export type TickAction = z.infer<typeof TickActionSchema>;

export interface ArmedOrderEvaluation {
  armedOrderId: string;
  action: TickAction;
  conditionEvaluations: ConditionEvaluation[];
  reasons: string[];
}

// ── Send result (the "did the trade actually go out" record) ─────────────
export interface RawSendResult {
  ok: boolean;
  brokerOrderId?: string;
  fillPrice?: number;
  fillTime?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ConditionalExecutionPort {
  sendOrder(order: PendingOrder & { clientOrderId: string }): Promise<RawSendResult>;
}

export const FireOutcomeStatusSchema = z.enum([
  "FILLED", "REJECTED", "ERROR",
]);
export type FireOutcomeStatus = z.infer<typeof FireOutcomeStatusSchema>;

export interface FireOutcome {
  status: FireOutcomeStatus;
  brokerOrderId: string | null;
  fillPrice: number | null;
  fillTime: string | null;
  reasons: string[];
}

export interface TickOutcome {
  armedOrderId: string;
  action: TickAction;
  newStatus: ArmedOrderStatus;
  conditionEvaluations: ConditionEvaluation[];
  fireOutcome: FireOutcome | null;
  reasons: string[];
}

// ── Armed Order Store (Port) ─────────────────────────────────────────────
export interface ArmedOrderStorePort {
  put(order: ArmedOrder): Promise<void>;
  get(armedOrderId: string): Promise<ArmedOrder | null>;
  listArmed(): Promise<ArmedOrder[]>;
  updateStatus(armedOrderId: string, status: ArmedOrderStatus): Promise<void>;
}

// ── Thresholds (extension hooks) ─────────────────────────────────────────
export const CONDITIONAL_EXECUTION_DEFAULTS = {
  defaultCombinator: "ALL" as Combinator,
} as const;
