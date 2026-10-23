// Execution Preview — TYPES (Task #196, Execution Cost & Survivability).
//
// Pure, self-contained contract for the PRE-TRADE execution-cost estimator.
// It converts price distances into money using REAL broker symbol specs plus
// ARX's standard per-symbol contract model, and surfaces the honest economics
// of a trade BEFORE the user commits: spread cost, lot-scaled slippage,
// expected fill range, starting drawdown (pain-before-profit), break-even,
// TP/SL & R:R after cost, survivability, account impact, order-type
// recommendation, multi-entry exposure / scaling, and a broker-condition
// downgrade/block.
//
// SAFETY (inviolable):
// - Pure types + pure functions only. No IO, DB, HTTP, Date.now, or randomness.
// - ADVISORY ONLY. Nothing here gates, slows, or places a trade. The 16-gate
//   live pipeline + kill switch remain the only things that can stop a trade.
// - HONEST. When a broker number is missing, the estimate degrades and SAYS SO
//   (`dataQuality.degraded` + a plain-English note). Never fabricate a number,
//   never substitute sim/mock/paper data.
// - No internal enum tokens in any user-facing string (blockers / warnings /
//   notes / disclaimer / order-type notes / recommendation).

import type { PreTradeBrokerSpec } from "../safety-contracts/preTradeBrokerGuard";

export type ExecutionPreviewSide = "BUY" | "SELL";
export type ExecutionOrderType = "MARKET" | "LIMIT" | "STOP";

/** Where the slippage estimate came from (honest provenance). */
export type SlippageSource = "HISTORY" | "SPREAD_FALLBACK" | "VOLATILITY_FALLBACK";

/** Broker-condition verdict for the preview as a whole. */
export type BrokerConditionVerdict = "OK" | "DOWNGRADE" | "BLOCK";

/** A summary of recent realised slippage for this user+symbol (read-only). */
export interface SlippageHistorySummary {
  /** Number of observed fills the average is built from. */
  sampleCount: number;
  /** Mean observed slippage in PRICE POINTS (absolute, >= 0). */
  meanPoints: number;
  /** Worst observed slippage in PRICE POINTS (absolute, >= 0). */
  worstPoints: number;
}

/** Current top-of-book quote snapshot. */
export interface ExecutionPreviewQuote {
  bid: number | null;
  ask: number | null;
  /** Age of the last tick in ms. null/large => treated as stale. */
  quoteAgeMs: number | null;
}

/** Existing open exposure on the SAME symbol (for multi-entry awareness). */
export interface OpenExposureSummary {
  /** Net open lots already on this symbol for this user (>= 0). */
  openLots: number;
  /** How many separate open positions on this symbol. */
  positionCount: number;
  /** Net side of existing exposure, when one-directional. */
  netSide: ExecutionPreviewSide | null;
}

export interface ExecutionPreviewInput {
  symbol: string;
  side: ExecutionPreviewSide;
  orderType: ExecutionOrderType;
  /** Intended entry price (limit/stop) or null to use mid/last for market. */
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Order size in lots (> 0). */
  lots: number;
  /** Broker symbol spec (point, volume bounds, trade mode, stops level…). */
  spec: PreTradeBrokerSpec;
  /** True when `spec` came from a real EA report (not a static guess). */
  hasBrokerTruth: boolean;
  quote: ExecutionPreviewQuote;
  /** Recent recent ATR / volatility in PRICE units (>= 0) or null. */
  atrPrice: number | null;
  /** Per-user+symbol realised-slippage summary, or null when none recorded. */
  slippageHistory: SlippageHistorySummary | null;
  /** Account balance in account currency, or null when unknown. */
  accountBalance: number | null;
  /** Account leverage (e.g. 100 for 1:100), or null when unknown. */
  leverage: number | null;
  /** Risk budget as a % of balance the user intends per trade (advisory). */
  riskPercent: number | null;
  /** Existing open exposure on this symbol (multi-entry awareness) or null. */
  openExposure: OpenExposureSummary | null;
  /** Max spread (in points) the user tolerates before a downgrade/block. */
  maxSpreadPoints: number;
}

/** Money + points pair (a cost or distance expressed both ways). */
export interface CostAmount {
  points: number;
  money: number | null; // null when money cannot be derived (no value model)
}

export interface SlippageEstimate {
  source: SlippageSource;
  expectedPoints: number;
  worstPoints: number;
  expectedMoney: number | null;
  worstMoney: number | null;
  /** Plain-English provenance, e.g. "from your recent fills" / fallback note. */
  note: string;
}

export interface ExpectedFillRange {
  /** Best-case fill price (least adverse). */
  low: number;
  /** Worst-case fill price (most adverse, after worst slippage). */
  high: number;
  /** The single most-likely fill price. */
  expected: number;
}

export interface AfterCostOutcome {
  /** Net loss at stop loss after spread + expected slippage (money, >= 0). */
  stopLossMoney: number | null;
  /** Net gain at take profit after spread + expected slippage (money). */
  takeProfitMoney: number | null;
  /** Reward:risk after cost, or null when SL/TP not both present. */
  riskRewardRatio: number | null;
  /** Gross (pre-cost) reward:risk for comparison, or null. */
  grossRiskRewardRatio: number | null;
}

export interface SurvivabilityEstimate {
  /** 0..100 — higher = the stop is more likely to survive noise. */
  score: number;
  /** Stop distance expressed in ATRs (null when ATR unknown). */
  stopDistanceAtr: number | null;
  /** True when the stop comfortably clears a normal pullback (>= ~1 ATR). */
  survivesNormalPullback: boolean | null;
  /** True when the stop sits beyond typical structure noise (>= ~2 ATR). */
  survivesStructureInvalidation: boolean | null;
  note: string;
}

export interface AccountImpact {
  /** Estimated margin required to open (money) or null. */
  marginRequired: number | null;
  /** Margin as a % of balance, or null. */
  marginPctOfBalance: number | null;
  /** Money at risk to the stop loss after cost, or null. */
  riskMoney: number | null;
  /** Risk as a % of balance, or null. */
  riskPctOfBalance: number | null;
  note: string;
}

export interface OrderTypeOption {
  type: ExecutionOrderType;
  /** 0..100 likelihood the order fills under current conditions. */
  fillLikelihood: number;
  /** Relative execution-cost expectation: lower money = cheaper. */
  expectedCostMoney: number | null;
  recommended: boolean;
  note: string;
}

export interface MultiEntryPlan {
  /** True when the user already holds exposure on this symbol. */
  hasExistingExposure: boolean;
  /** Combined lots after this order fills. */
  combinedLots: number;
  /** Combined risk money across existing + new (when computable). */
  combinedRiskMoney: number | null;
  /** True when this order ADDS to a position in the same direction. */
  addsToSameDirection: boolean;
  /** True when this order OPPOSES existing exposure (hedge/reduce). */
  opposesExisting: boolean;
  /** A simple, conservative scaling suggestion. */
  scalingNote: string;
}

export interface BrokerCondition {
  verdict: BrokerConditionVerdict;
  /** User-facing reasons for a downgrade/block (plain English). */
  reasons: string[];
}

export interface ExecutionDataQuality {
  hasBrokerTruth: boolean;
  /** True when ANY part of the estimate had to degrade. */
  degraded: boolean;
  /** Plain-English notes on what was estimated vs measured. */
  notes: string[];
}

/** The Part 52 execution-preview object. */
export interface ExecutionPreview {
  symbol: string;
  side: ExecutionPreviewSide;
  orderType: ExecutionOrderType;
  lots: number;
  /** Reference price the preview was built against (entry / mid / last). */
  referencePrice: number | null;
  /** Smallest price increment used for point math (broker or inferred). */
  pointSize: number;
  /** True when pointSize was inferred from price magnitude (not broker truth). */
  pointInferred: boolean;
  /** Money value of ONE point of price movement at this lot size, or null. */
  moneyPerPoint: number | null;
  /** Spread cost to enter at this lot size. */
  spreadCost: CostAmount;
  slippage: SlippageEstimate;
  expectedFillRange: ExpectedFillRange | null;
  /** Pain-before-profit: expected starting drawdown right after entry. */
  startingDrawdown: CostAmount;
  /** Distance price must move just to cover entry cost. */
  breakEven: CostAmount;
  afterCost: AfterCostOutcome;
  survivability: SurvivabilityEstimate;
  accountImpact: AccountImpact;
  orderTypes: OrderTypeOption[];
  multiEntry: MultiEntryPlan | null;
  brokerCondition: BrokerCondition;
  dataQuality: ExecutionDataQuality;
  /** Hard blockers (the preview is not viable as configured). */
  blockers: string[];
  /** Non-blocking cautions. */
  warnings: string[];
  disclaimer: string;
}
