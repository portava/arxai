import { advanceStudyAverage, chartTrueRange, type SeededAverageState } from "../chart-indicator-math/index.js";

/** Portable pure deterministic research core. No crypto, broker, clock, database,
 * optimizer or callback can enter this engine. Not exported from the browser-
 * consumed /backtest barrel. See docs/CAUSAL_RESEARCH_ENGINE.md for assumptions. */
export const RESEARCH_ENGINE_VERSION = "arx-mid-ohlc-research-v1" as const;
export const RESEARCH_STRATEGY_VERSION = "close-momentum-v1" as const;
export const MAX_RESEARCH_BARS = 100_000;

export interface ResearchBar {
  openTimeMs: number;
  open: number; high: number; low: number; close: number;
}
export interface ResearchInput {
  symbol: string;
  priceBasis: "MID";
  intervalMs: number;
  /** Explicit historical knowledge cutoff; every supplied bar must be closed. */
  asOfMs: number;
  source: { kind: "generated" | "historical_unattested"; reference: string };
  bars: readonly ResearchBar[];
}
export interface ResearchConfig {
  strategy: {
    version: typeof RESEARCH_STRATEGY_VERSION;
    /** Compare close[i] with close[i-lookbackBars]. Strict threshold, no fit. */
    lookbackBars: number;
    thresholdPriceUnits: number;
    stopDistancePriceUnits: number;
    targetDistancePriceUnits: number;
    /** Schedule a market exit at the NEXT observed open after this many bars. */
    maxHoldingBars: number;
  };
  costs: {
    /** Constant ask-minus-bid scenario, not measured historical spread. */
    fullSpreadPriceUnits: number;
    adverseSlippagePerFillPriceUnits: number;
    /** Fee equivalent per unit per side; NOT currency or a broker default. */
    feePerFillPriceUnits: number;
  };
  /** Pending entry expires across a gap greater than this explicit tolerance. */
  maxEntryGapMs: number;
  splits: { trainEndExclusive: number; validationEndExclusive: number };
}
export type ResearchSide = "BUY" | "SELL";
export interface ResearchDecision {
  signalIndex: number;
  knownThroughMs: number;
  side: ResearchSide;
  momentumPriceUnits: number;
  disposition: "filled" | "gap_expired" | "invalid_bracket" | "partition_ended" | "insufficient_capital";
  entryIndex: number | null;
}
interface ResearchPosition {
  signalIndex: number; entryIndex: number; side: ResearchSide;
  entryTimeMs: number; entryMid: number; entryPrice: number;
  /** Stop and target are trigger prices on the position's liquidation side. */
  stopPrice: number; targetPrice: number;
}
export interface ResearchTrade extends ResearchPosition {
  exitIndex: number;
  /** OHLC cannot identify an intrabar fill timestamp. */
  exitTime: { earliestMs: number; latestMs: number; precision: "open" | "bar_interval" };
  exitMid: number; exitPrice: number;
  reason: "stop" | "stop_gap" | "target" | "target_gap_capped" | "max_hold_next_open";
  ambiguousStopAndTarget: boolean;
  grossPriceUnits: number;
  spreadCostPriceUnits: number;
  slippageCostPriceUnits: number;
  feeCostPriceUnits: number;
  netPriceUnits: number;
}
export interface ResearchOpenObservation extends ResearchPosition {
  observedThroughMs: number;
  markMid: number;
  hypotheticalLiquidationPrice: number;
  netIfLiquidatedPriceUnits: number;
  paidEntryFeePriceUnits: number;
  estimatedExitFeePriceUnits: number;
  exitScheduledForNextOpen: boolean;
  outcome: "unresolved";
}
export interface ResearchPartition {
  name: "train" | "validation" | "holdout";
  fromInclusive: number; toExclusive: number;
  decisions: ResearchDecision[];
  trades: ResearchTrade[];
  openPosition: ResearchOpenObservation | null;
  status: "no_signals" | "no_completed_trades" | "open_outcome" | "completed" | "completed_and_open";
  metrics: {
    completedTrades: number;
    completedNetPriceUnits: number;
    winRate: number | null;
    profitFactor: number | null;
    profitFactorUnavailable: "no_completed_trades" | "no_losses" | null;
    /** Zero-origin net P&L, including a cost-aware hypothetical open exit. */
    lastMarkedNetPriceUnits: number;
    /** Observed bar-close marks only; NOT worst intrabar/entry excursion. */
    maxMarkedDrawdownPriceUnits: number;
  };
  markedCurve: { index: number; observedThroughMs: number; netPriceUnits: number }[];
}
export interface ResearchResult {
  engineVersion: typeof RESEARCH_ENGINE_VERSION;
  classification: "diagnostic";
  verification: "unverified";
  pnlUnit: "price_units_per_unit";
  strategySelection: "fixed_parameters_no_training_or_optimization";
  authority: { promotionEligible: false; brokerVerified: false; persistedExperiment: false };
  inputSnapshot: ResearchInput;
  configSnapshot: ResearchConfig;
  fingerprints: { algorithm: "sha256"; input: string; configuration: string; strategy: string; result: string };
  gapCount: number;
  partitions: ResearchPartition[];
  limitations: string[];
}
export const RESEARCH_V2_ENGINE_VERSION = "arx-quote-ohlc-research-v2" as const;
export const RESEARCH_V2_STRATEGY_VERSION = "ema-cross-atr-v1" as const;
export interface ResearchV2Input extends Omit<ResearchInput, "priceBasis"> { priceBasis: "MID" | "BID" }
export interface ResearchV2Strategy {
  version: typeof RESEARCH_V2_STRATEGY_VERSION;
  fastPeriod: number; slowPeriod: number; atrPeriod: number;
  stopAtrMultiple: number; targetR: number; maxHoldingBars: number;
  direction: "both" | "long_only" | "short_only";
}
/** Explicit hypothetical fully-paid asset accounting; never broker contract metadata. */
export interface ResearchCashConfig {
  version: "cash-fixed-units-v1";
  initialCapital: number;
  fixedQuantity: number;
  /** Accounting units for a one-price-unit change in one quantity unit. */
  pointValue: number;
  unitLabel: string;
  benchmark: "same_quantity_buy_hold";
}
export interface ResearchCashPoint { index: number; observedThroughMs: number; cash: number; equity: number; benchmarkEquity: number }
export interface ResearchCashAccount {
  version: "cash-fixed-units-v1"; initialCapital: number; unitLabel: string;
  completedNet: number; completedCosts: number; lastEquity: number;
  totalReturnPercent: number; annualizedReturnPercent: number | null;
  maxDrawdown: number; maxDrawdownPercent: number; capitalDeficit: boolean;
  benchmark: {status:"entered_unresolved"|"insufficient_capital";entryPrice:number|null;lastEquity:number;totalReturnPercent:number};
  curve: ResearchCashPoint[];
}
export interface ResearchV2Config extends Omit<ResearchConfig, "strategy"> { strategy: ResearchV2Strategy; cash?: ResearchCashConfig }
export interface ResearchV2SignalEvidence {
  previousFastEma: number; previousSlowEma: number; fastEma: number; slowEma: number; atr: number;
  stopDistancePriceUnits: number; targetDistancePriceUnits: number;
}
export interface ResearchV2Decision extends Omit<ResearchDecision, "momentumPriceUnits"> { signal: ResearchV2SignalEvidence }
export interface ResearchV2Trade extends Omit<ResearchTrade, "entryMid" | "exitMid"> {
  entryReferencePrice: number; exitReferencePrice: number;
}
export interface ResearchV2OpenObservation extends Omit<ResearchOpenObservation, "entryMid" | "markMid"> {
  entryReferencePrice: number; markReferencePrice: number;
}
export interface ResearchV2Partition extends Omit<ResearchPartition, "decisions" | "trades" | "openPosition"> {
  decisions: ResearchV2Decision[]; trades: ResearchV2Trade[]; openPosition: ResearchV2OpenObservation | null; cash?: ResearchCashAccount;
}
export interface ResearchV2Result extends Omit<ResearchResult, "engineVersion" | "inputSnapshot" | "configSnapshot" | "partitions"> {
  engineVersion: typeof RESEARCH_V2_ENGINE_VERSION;
  inputSnapshot: ResearchV2Input; configSnapshot: ResearchV2Config; partitions: ResearchV2Partition[];
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
    : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export class ResearchInputError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ResearchInputError"; }
}
function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ResearchInputError(code);
}
function finite(value: number, code: string): number {
  requireCondition(Number.isFinite(value), code);
  return Object.is(value, -0) ? 0 : value;
}
function cashAmount(value:number,scale:number):number {
  const amount=finite(value*scale,"ACCOUNT_OVERFLOW");
  requireCondition(value===0||amount!==0&&Number.isFinite(amount/scale)&&Math.abs(amount/scale-value)<=Math.max(Number.MIN_VALUE,Math.abs(value)*1e-8),"ACCOUNT_PRECISION_LOSS");
  return amount;
}
function cashMove(balance:number,delta:number):number {
  const next=finite(balance+delta,"ACCOUNT_OVERFLOW");
  requireCondition(delta===0 || next!==balance && Math.abs((next-balance)-delta)<=Math.max(Number.MIN_VALUE,Math.abs(delta)*1e-8),"ACCOUNT_PRECISION_LOSS");
  return next;
}
function positive(value: number, code: string): number {
  requireCondition(Number.isFinite(value) && value > 0, code); return value;
}
function nonnegative(value: number, code: string): number {
  requireCondition(Number.isFinite(value) && value >= 0, code); return value === 0 ? 0 : value;
}
function integer(value: number, minimum: number, maximum: number, code: string): number {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum, code); return value;
}
function label(value: string, code: string): string {
  requireCondition(typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value, code); return value;
}
export function freezeResearch<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeResearch(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export function validateResearchV2Strategy(raw: ResearchV2Strategy): ResearchV2Strategy {
  requireCondition(raw && raw.version === RESEARCH_V2_STRATEGY_VERSION, "UNSUPPORTED_STRATEGY");
  const fastPeriod = integer(raw.fastPeriod, 1, 1000, "INVALID_FAST_PERIOD");
  const slowPeriod = integer(raw.slowPeriod, 2, 1000, "INVALID_SLOW_PERIOD");
  requireCondition(fastPeriod < slowPeriod, "FAST_PERIOD_MUST_BE_LESS_THAN_SLOW");
  const stopAtrMultiple = positive(raw.stopAtrMultiple, "INVALID_STOP_ATR_MULTIPLE");
  const targetR = positive(raw.targetR, "INVALID_TARGET_R");
  requireCondition(stopAtrMultiple <= 100 && targetR <= 100, "BRACKET_MULTIPLE_OUT_OF_BOUNDS");
  requireCondition(["both", "long_only", "short_only"].includes(raw.direction), "INVALID_DIRECTION");
  return { version: RESEARCH_V2_STRATEGY_VERSION, fastPeriod, slowPeriod,
    atrPeriod: integer(raw.atrPeriod, 1, 1000, "INVALID_ATR_PERIOD"), stopAtrMultiple, targetR,
    maxHoldingBars: integer(raw.maxHoldingBars, 1, 10000, "INVALID_HOLDING_PERIOD"), direction: raw.direction };
}
export function validateResearchCashConfig(raw: ResearchCashConfig): ResearchCashConfig {
  requireCondition(raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).every(key=>["version","initialCapital","fixedQuantity","pointValue","unitLabel","benchmark"].includes(key)), "UNSUPPORTED_CASH_SETTINGS");
  requireCondition(raw.version === "cash-fixed-units-v1" && raw.benchmark === "same_quantity_buy_hold", "UNSUPPORTED_CASH_MODEL");
  const initialCapital=positive(raw.initialCapital,"INVALID_STARTING_CAPITAL"),fixedQuantity=positive(raw.fixedQuantity,"INVALID_QUANTITY"),pointValue=positive(raw.pointValue,"INVALID_POINT_VALUE");
  positive(cashAmount(fixedQuantity,pointValue),"INVALID_ACCOUNT_SCALE");
  requireCondition(typeof raw.unitLabel === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(raw.unitLabel) && raw.unitLabel.trim()===raw.unitLabel,"INVALID_ACCOUNT_UNIT_LABEL");
  return {version:"cash-fixed-units-v1",initialCapital,fixedQuantity,pointValue,unitLabel:raw.unitLabel,benchmark:"same_quantity_buy_hold"};
}
export function validateResearchV2Config(raw: ResearchV2Config, barCount: number): ResearchV2Config {
  requireCondition(raw && raw.costs && raw.splits, "MISSING_INPUT_OR_CONFIG");
  integer(barCount, 3, MAX_RESEARCH_BARS, "BAR_COUNT_OUT_OF_BOUNDS");
  const strategy = validateResearchV2Strategy(raw.strategy);
  const costs = validateCosts(raw.costs);
  const cash=raw.cash===undefined?undefined:validateResearchCashConfig(raw.cash);
  requireCondition(!cash||strategy.direction==="long_only","CASH_LONG_ONLY_REQUIRED");
  if(cash)for(const cost of Object.values(costs))cashAmount(cost,cash.fixedQuantity*cash.pointValue);
  const trainEndExclusive = integer(raw.splits.trainEndExclusive, 1, barCount - 2, "INVALID_TRAIN_SPLIT");
  const validationEndExclusive = integer(raw.splits.validationEndExclusive, trainEndExclusive + 1, barCount - 1, "INVALID_VALIDATION_SPLIT");
  return { strategy, costs, maxEntryGapMs: integer(raw.maxEntryGapMs, 0, 366 * 86400000, "INVALID_ENTRY_GAP"),
    splits: { trainEndExclusive, validationEndExclusive }, ...(cash?{cash}:{}) };
}
function validateCosts(raw: ResearchConfig["costs"]): ResearchConfig["costs"] {
  const costs = { fullSpreadPriceUnits: nonnegative(raw.fullSpreadPriceUnits, "INVALID_SPREAD"),
    adverseSlippagePerFillPriceUnits: nonnegative(raw.adverseSlippagePerFillPriceUnits, "INVALID_SLIPPAGE"),
    feePerFillPriceUnits: nonnegative(raw.feePerFillPriceUnits, "INVALID_FEE") };
  finite(costs.fullSpreadPriceUnits + 2 * costs.adverseSlippagePerFillPriceUnits + 2 * costs.feePerFillPriceUnits, "COST_TOTAL_OVERFLOW");
  return costs;
}

function snapshots(raw: ResearchInput, config: ResearchConfig): { input: ResearchInput; config: ResearchConfig; gaps: number } {
  requireCondition(raw && config && config.strategy && config.costs && config.splits && raw.source, "MISSING_INPUT_OR_CONFIG");
  requireCondition(raw.priceBasis === "MID", "MID_PRICE_BASIS_REQUIRED");
  requireCondition(raw.source.kind === "generated" || raw.source.kind === "historical_unattested", "UNSUPPORTED_SOURCE");
  requireCondition(Array.isArray(raw.bars) && raw.bars.length > 0 && raw.bars.length <= MAX_RESEARCH_BARS, "BAR_COUNT_OUT_OF_BOUNDS");
  requireCondition(config.strategy.version === RESEARCH_STRATEGY_VERSION, "UNSUPPORTED_STRATEGY");
  const intervalMs = integer(raw.intervalMs, 1, 366 * 86400000, "INVALID_INTERVAL");
  const asOfMs = integer(raw.asOfMs, 1, 8_640_000_000_000_000, "INVALID_AS_OF");
  const costs = validateCosts(config.costs);
  const { bars, gaps } = copyResearchBars(raw.bars, intervalMs, asOfMs, costs, "MID");
  const trainEndExclusive = integer(config.splits.trainEndExclusive, 1, bars.length - 2, "INVALID_TRAIN_SPLIT");
  const validationEndExclusive = integer(config.splits.validationEndExclusive, trainEndExclusive + 1, bars.length - 1, "INVALID_VALIDATION_SPLIT");
  return {
    input: { symbol: label(raw.symbol, "INVALID_SYMBOL"), priceBasis: "MID", intervalMs, asOfMs,
      source: { kind: raw.source.kind, reference: label(raw.source.reference, "INVALID_SOURCE_REFERENCE") }, bars },
    config: {
      strategy: { version: RESEARCH_STRATEGY_VERSION,
        lookbackBars: integer(config.strategy.lookbackBars, 1, 10000, "INVALID_LOOKBACK"),
        thresholdPriceUnits: nonnegative(config.strategy.thresholdPriceUnits, "INVALID_THRESHOLD"),
        stopDistancePriceUnits: positive(config.strategy.stopDistancePriceUnits, "INVALID_STOP_DISTANCE"),
        targetDistancePriceUnits: positive(config.strategy.targetDistancePriceUnits, "INVALID_TARGET_DISTANCE"),
        maxHoldingBars: integer(config.strategy.maxHoldingBars, 1, 10000, "INVALID_HOLDING_PERIOD") },
      costs,
      maxEntryGapMs: integer(config.maxEntryGapMs, 0, 366 * 86400000, "INVALID_ENTRY_GAP"),
      splits: { trainEndExclusive, validationEndExclusive },
    }, gaps,
  };
}
function copyResearchBars(rawBars: readonly ResearchBar[], intervalMs: number, asOfMs: number,
  costs: ResearchConfig["costs"], basis: "BID" | "MID") {
  let previousClose = -1, gaps = 0;
  // Array.from visits sparse slots; Array.map would silently preserve holes.
  const bars = Array.from(rawBars, bar => {
    requireCondition(bar, "MISSING_BAR");
    const openTimeMs = integer(bar.openTimeMs, 0, asOfMs - intervalMs, "BAR_NOT_CLOSED_AT_AS_OF");
    requireCondition(openTimeMs >= previousClose, "UNORDERED_DUPLICATE_OR_OVERLAPPING_BARS");
    if (previousClose >= 0 && openTimeMs > previousClose) gaps++;
    previousClose = openTimeMs + intervalMs;
    const open = positive(bar.open, "INVALID_OHLC"), high = positive(bar.high, "INVALID_OHLC"),
      low = positive(bar.low, "INVALID_OHLC"), close = positive(bar.close, "INVALID_OHLC");
    requireCondition(low <= open && low <= close && high >= open && high >= close && low <= high, "INCOHERENT_OHLC");
    requireCondition(low > (basis === "BID" ? 0 : costs.fullSpreadPriceUnits / 2) + costs.adverseSlippagePerFillPriceUnits, "NONPOSITIVE_MODELED_QUOTE");
    finite(high + (basis === "BID" ? costs.fullSpreadPriceUnits : costs.fullSpreadPriceUnits / 2) + costs.adverseSlippagePerFillPriceUnits, "QUOTE_OVERFLOW");
    return { openTimeMs, open, high, low, close };
  });
  return { bars, gaps };
}
function snapshotV2(raw: ResearchV2Input, rawConfig: ResearchV2Config) {
  requireCondition(raw && rawConfig && raw.source, "MISSING_INPUT_OR_CONFIG");
  requireCondition(raw.priceBasis === "BID" || raw.priceBasis === "MID", "UNSUPPORTED_PRICE_BASIS");
  requireCondition(raw.source.kind === "generated" || raw.source.kind === "historical_unattested", "UNSUPPORTED_SOURCE");
  requireCondition(Array.isArray(raw.bars) && raw.bars.length >= 3 && raw.bars.length <= MAX_RESEARCH_BARS, "BAR_COUNT_OUT_OF_BOUNDS");
  const intervalMs = integer(raw.intervalMs, 1, 366 * 86400000, "INVALID_INTERVAL");
  const asOfMs = integer(raw.asOfMs, 1, 8_640_000_000_000_000, "INVALID_AS_OF");
  const config = validateResearchV2Config(rawConfig, raw.bars.length);
  const { bars, gaps } = copyResearchBars(raw.bars, intervalMs, asOfMs, config.costs, raw.priceBasis);
  const input: ResearchV2Input = { symbol: label(raw.symbol, "INVALID_SYMBOL"), priceBasis: raw.priceBasis, intervalMs, asOfMs,
    source: {kind: raw.source.kind, reference: label(raw.source.reference, "INVALID_SOURCE_REFERENCE")}, bars };
  return { input, config, gaps };
}
function emaAtrFeatures(bars: readonly ResearchBar[], strategy: ResearchV2Strategy): (ResearchV2SignalEvidence | null)[] {
  let fast: SeededAverageState | undefined, slow: SeededAverageState | undefined, atr: SeededAverageState | undefined;
  const ranges: number[] = [], features: (ResearchV2SignalEvidence | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!, previousFast = fast?.value, previousSlow = slow?.value;
    ranges.push(finite(chartTrueRange(bar, bars[i - 1]?.close), "INDICATOR_OVERFLOW"));
    fast = advanceStudyAverage(bar.close, strategy.fastPeriod, "ema", fast, bars[i - strategy.fastPeriod]?.close ?? 0);
    slow = advanceStudyAverage(bar.close, strategy.slowPeriod, "ema", slow, bars[i - strategy.slowPeriod]?.close ?? 0);
    atr = advanceStudyAverage(ranges[i]!, strategy.atrPeriod, "smma", atr, ranges[i - strategy.atrPeriod] ?? 0);
    for (const state of [fast, slow, atr]) { finite(state.sum, "INDICATOR_OVERFLOW"); if (state.value != null) finite(state.value, "INDICATOR_OVERFLOW"); }
    if (previousFast == null || previousSlow == null || fast.value == null || slow.value == null || atr.value == null || atr.value <= 0) { features.push(null); continue; }
    const stopDistancePriceUnits = positive(atr.value * strategy.stopAtrMultiple, "BRACKET_OVERFLOW");
    const targetDistancePriceUnits = positive(stopDistancePriceUnits * strategy.targetR, "BRACKET_OVERFLOW");
    features.push({ previousFastEma: previousFast, previousSlowEma: previousSlow, fastEma: fast.value, slowEma: slow.value,
      atr: atr.value, stopDistancePriceUnits, targetDistancePriceUnits });
  }
  return features;
}
type InternalDecision = ResearchDecision | ResearchV2Decision;
type InternalPartition = Omit<ResearchPartition, "decisions"> & {decisions: InternalDecision[];cash?:ResearchCashAccount};
const direction = (side: ResearchSide) => side === "BUY" ? 1 : -1;

function runPartition(name: ResearchPartition["name"], from: number, to: number, input: ResearchInput | ResearchV2Input, config: ResearchConfig | ResearchV2Config, features?: (ResearchV2SignalEvidence | null)[]): InternalPartition {
  const { bars, intervalMs } = input, { strategy, costs } = config;
  const halfSpread = costs.fullSpreadPriceUnits / 2, slip = costs.adverseSlippagePerFillPriceUnits;
  const decisions: InternalDecision[] = [], trades: ResearchTrade[] = [], markedCurve: ResearchPartition["markedCurve"] = [];
  let position: ResearchPosition | null = null, pending: InternalDecision | null = null, exitNextOpen = false;
  let completedNet = 0, markedNet = 0, peak = 0, drawdown = 0;
  const cashConfig="cash" in config?config.cash:undefined,scale=cashConfig?positive(cashConfig.fixedQuantity*cashConfig.pointValue,"INVALID_ACCOUNT_SCALE"):1;
  const cashCurve:ResearchCashPoint[]=[];
  let availableCash=cashConfig?.initialCapital??0;
  const entryFill=(reference:number,side:ResearchSide)=>finite(input.priceBasis==="BID"?reference+(side==="BUY"?costs.fullSpreadPriceUnits+slip:-slip):reference+direction(side)*(halfSpread+slip),"ENTRY_PRICE_OVERFLOW");
  const exitPrice = (reference: number, side: ResearchSide) => finite(input.priceBasis === "BID"
    ? reference + (side === "SELL" ? costs.fullSpreadPriceUnits + slip : -slip)
    : reference - direction(side) * (halfSpread + slip), "EXIT_PRICE_OVERFLOW");
  const netAt = (p: ResearchPosition, mid: number) => finite(direction(p.side) * (exitPrice(mid, p.side) - p.entryPrice) - 2 * costs.feePerFillPriceUnits, "PNL_OVERFLOW");
  const benchmarkEntry=cashConfig?entryFill(bars[from]!.open,"BUY"):null;
  const benchmarkDebit=benchmarkEntry==null?0:positive(cashAmount(benchmarkEntry+costs.feePerFillPriceUnits,scale),"INVALID_ACCOUNT_DEBIT");
  const benchmarkEntered=!!cashConfig&&benchmarkDebit<=cashConfig.initialCapital;
  for (let i = from; i < to; i++) {
    const bar = bars[i]!;
    if (pending) {
      if (bar.openTimeMs - pending.knownThroughMs > config.maxEntryGapMs) pending.disposition = "gap_expired";
      else {
        const sign = direction(pending.side), entryPrice = entryFill(bar.open,pending.side);
        const brackets = "signal" in pending ? pending.signal : strategy as ResearchConfig["strategy"];
        const stopPrice = finite(entryPrice - sign * brackets.stopDistancePriceUnits, "BRACKET_OVERFLOW");
        const targetPrice = finite(entryPrice + sign * brackets.targetDistancePriceUnits, "BRACKET_OVERFLOW");
        const debit=cashConfig?positive(cashAmount(entryPrice+costs.feePerFillPriceUnits,scale),"INVALID_ACCOUNT_DEBIT"):0;
        if (stopPrice <= 0 || targetPrice <= 0) pending.disposition = "invalid_bracket";
        else if(cashConfig&&debit>availableCash)pending.disposition="insufficient_capital";
        else {
          if(cashConfig)availableCash=cashMove(availableCash,-debit);
          pending.disposition = "filled"; pending.entryIndex = i;
          position = { signalIndex: pending.signalIndex, entryIndex: i, side: pending.side,
            entryTimeMs: bar.openTimeMs, entryMid: bar.open, entryPrice, stopPrice, targetPrice };
        }
      }
      pending = null;
    }
    if (position) {
      const p = position, sign = direction(p.side);
      const bidAskShift = input.priceBasis === "BID" ? (p.side === "SELL" ? costs.fullSpreadPriceUnits : 0) : -sign * halfSpread;
      const quoteOpen = bar.open + bidAskShift, quoteLow = bar.low + bidAskShift, quoteHigh = bar.high + bidAskShift;
      const stopGap = sign === 1 ? quoteOpen <= p.stopPrice : quoteOpen >= p.stopPrice;
      const targetGap = sign === 1 ? quoteOpen >= p.targetPrice : quoteOpen <= p.targetPrice;
      const stopTouched = sign === 1 ? quoteLow <= p.stopPrice : quoteHigh >= p.stopPrice;
      const targetTouched = sign === 1 ? quoteHigh >= p.targetPrice : quoteLow <= p.targetPrice;
      let reason: ResearchTrade["reason"] | null = null, reference = 0, atOpen = false, ambiguous = false;
      if (stopGap) { reason = "stop_gap"; reference = bar.open; atOpen = true; }
      else if (targetGap) { reason = "target_gap_capped"; reference = p.targetPrice - bidAskShift; atOpen = true; }
      else if (exitNextOpen) { reason = "max_hold_next_open"; reference = bar.open; atOpen = true; }
      else if (stopTouched) { reason = "stop"; reference = p.stopPrice - bidAskShift; ambiguous = targetTouched; }
      else if (targetTouched) { reason = "target"; reference = p.targetPrice - bidAskShift; }
      if (reason) {
        const trade: ResearchTrade = { ...p, exitIndex: i,
          exitTime: { earliestMs: bar.openTimeMs, latestMs: atOpen ? bar.openTimeMs : bar.openTimeMs + intervalMs,
            precision: atOpen ? "open" : "bar_interval" },
          exitMid: reference, exitPrice: exitPrice(reference, p.side), reason, ambiguousStopAndTarget: ambiguous,
          grossPriceUnits: finite(sign * (reference - p.entryMid), "PNL_OVERFLOW"),
          spreadCostPriceUnits: costs.fullSpreadPriceUnits, slippageCostPriceUnits: 2 * slip,
          feeCostPriceUnits: 2 * costs.feePerFillPriceUnits, netPriceUnits: netAt(p, reference) };
        trades.push(trade); completedNet = finite(completedNet + trade.netPriceUnits, "PNL_OVERFLOW");
        if(cashConfig)availableCash=cashMove(availableCash,cashAmount(trade.exitPrice-costs.feePerFillPriceUnits,scale));
        position = null; exitNextOpen = false;
      } else if (i - p.entryIndex + 1 >= strategy.maxHoldingBars) exitNextOpen = true;
    }
    // Only current/past closed observations are read. There is no user callback
    // with access to the dataset, no fitted parameter, and no future index here.
    if (!position && strategy.version === RESEARCH_V2_STRATEGY_VERSION) {
      const signal = features?.[i];
      if (signal) {
        const buy = signal.previousFastEma <= signal.previousSlowEma && signal.fastEma > signal.slowEma;
        const sell = signal.previousFastEma >= signal.previousSlowEma && signal.fastEma < signal.slowEma;
        const side = buy && strategy.direction !== "short_only" ? "BUY" : sell && strategy.direction !== "long_only" ? "SELL" : null;
        if (side) {
          pending = { signalIndex: i, knownThroughMs: bar.openTimeMs + intervalMs, side, signal,
            disposition: "partition_ended", entryIndex: null };
          decisions.push(pending);
        }
      }
    } else if (!position && strategy.version === RESEARCH_STRATEGY_VERSION && i >= strategy.lookbackBars) {
      const momentum = finite(bar.close - bars[i - strategy.lookbackBars]!.close, "MOMENTUM_OVERFLOW");
      if (Math.abs(momentum) > strategy.thresholdPriceUnits) {
        pending = { signalIndex: i, knownThroughMs: bar.openTimeMs + intervalMs,
          side: momentum > 0 ? "BUY" : "SELL", momentumPriceUnits: momentum,
          disposition: "partition_ended", entryIndex: null };
        decisions.push(pending);
      }
    }
    markedNet = finite(completedNet + (position ? netAt(position, bar.close) : 0), "PNL_OVERFLOW");
    peak = Math.max(peak, markedNet); drawdown = Math.max(drawdown, finite(peak - markedNet, "DRAWDOWN_OVERFLOW"));
    markedCurve.push({ index: i, observedThroughMs: bar.openTimeMs + intervalMs, netPriceUnits: markedNet });
    if(cashConfig){
      cashAmount(markedNet,scale);
      if(benchmarkEntered)cashAmount(exitPrice(bar.close,"BUY")-benchmarkEntry!-2*costs.feePerFillPriceUnits,scale);
      const equity=cashMove(availableCash,position?cashAmount(exitPrice(bar.close,"BUY")-costs.feePerFillPriceUnits,scale):0);
      const benchmarkEquity=benchmarkEntered?cashMove(cashMove(cashConfig.initialCapital,-benchmarkDebit),cashAmount(exitPrice(bar.close,"BUY")-costs.feePerFillPriceUnits,scale)):cashConfig.initialCapital;
      cashCurve.push({index:i,observedThroughMs:bar.openTimeMs+intervalMs,cash:availableCash,equity,benchmarkEquity});
    }
  }
  const last = bars[to - 1]!;
  const openPosition: ResearchOpenObservation | null = position ? { ...position,
    observedThroughMs: last.openTimeMs + intervalMs, markMid: last.close,
    hypotheticalLiquidationPrice: exitPrice(last.close, position.side), netIfLiquidatedPriceUnits: netAt(position, last.close),
    paidEntryFeePriceUnits: costs.feePerFillPriceUnits, estimatedExitFeePriceUnits: costs.feePerFillPriceUnits,
    exitScheduledForNextOpen: exitNextOpen, outcome: "unresolved" } : null;
  let wins = 0, grossWins = 0, grossLosses = 0;
  for (const trade of trades) {
    if (trade.netPriceUnits > 0) { wins++; grossWins = finite(grossWins + trade.netPriceUnits, "PNL_OVERFLOW"); }
    if (trade.netPriceUnits < 0) grossLosses = finite(grossLosses - trade.netPriceUnits, "PNL_OVERFLOW");
  }
  let cash:ResearchCashAccount|undefined;
  if(cashConfig){
    const initial=cashConfig.initialCapital,lastEquity=cashCurve.at(-1)!.equity;
    let equityPeak=initial,maxDrawdown=0,maxDrawdownPercent=0;
    for(const point of cashCurve){equityPeak=Math.max(equityPeak,point.equity);const drop=finite(equityPeak-point.equity,"ACCOUNT_OVERFLOW");maxDrawdown=Math.max(maxDrawdown,drop);maxDrawdownPercent=Math.max(maxDrawdownPercent,finite(drop/equityPeak*100,"ACCOUNT_OVERFLOW"));}
    const elapsedMs=last.openTimeMs+intervalMs-bars[from]!.openTimeMs,yearMs=365.25*86400000;
    const annualized=elapsedMs>=yearMs&&lastEquity>0?100*Math.expm1(Math.log(lastEquity/initial)*yearMs/elapsedMs):null;
    const benchmarkLast=cashCurve.at(-1)!.benchmarkEquity;
    cash={version:cashConfig.version,initialCapital:initial,unitLabel:cashConfig.unitLabel,
      completedNet:cashAmount(completedNet,scale),completedCosts:cashAmount(trades.reduce((sum,t)=>sum+t.spreadCostPriceUnits+t.slippageCostPriceUnits+t.feeCostPriceUnits,0),scale),lastEquity,
      totalReturnPercent:finite((lastEquity-initial)/initial*100,"ACCOUNT_OVERFLOW"),annualizedReturnPercent:annualized!=null&&Number.isFinite(annualized)?annualized:null,
      maxDrawdown,maxDrawdownPercent,capitalDeficit:cashCurve.some(point=>point.cash<0||point.equity<0),
      benchmark:{status:benchmarkEntered?"entered_unresolved":"insufficient_capital",entryPrice:benchmarkEntered?benchmarkEntry:null,lastEquity:benchmarkLast,totalReturnPercent:finite((benchmarkLast-initial)/initial*100,"ACCOUNT_OVERFLOW")},curve:cashCurve};
  }
  return { name, fromInclusive: from, toExclusive: to, decisions, trades, openPosition,...(cash?{cash}:{}),
    status: openPosition ? trades.length ? "completed_and_open" : "open_outcome"
      : trades.length ? "completed" : decisions.length ? "no_completed_trades" : "no_signals",
    metrics: { completedTrades: trades.length, completedNetPriceUnits: completedNet,
      winRate: trades.length ? wins / trades.length : null,
      profitFactor: grossLosses > 0 ? finite(grossWins / grossLosses, "PROFIT_FACTOR_OVERFLOW") : null,
      profitFactorUnavailable: !trades.length ? "no_completed_trades" : grossLosses === 0 ? "no_losses" : null,
      lastMarkedNetPriceUnits: markedNet, maxMarkedDrawdownPriceUnits: drawdown }, markedCurve };
}

/** Fixed-strategy chronological research, not strategy selection or proof of an
 * untouched holdout. Each partition starts flat; prior observations may warm
 * the fixed feature, but trades and pending signals never cross partitions. */
export function prepareCausalResearch(raw: ResearchInput, rawConfig: ResearchConfig) {
  const { input, config, gaps } = snapshots(raw, rawConfig);
  const { trainEndExclusive: train, validationEndExclusive: validation } = config.splits;
  const partitions = [runPartition("train", 0, train, input, config),
    runPartition("validation", train, validation, input, config), runPartition("holdout", validation, input.bars.length, input, config)] as ResearchPartition[];
  const body = {
    engineVersion: RESEARCH_ENGINE_VERSION, classification: "diagnostic" as const, verification: "unverified" as const,
    pnlUnit: "price_units_per_unit" as const, strategySelection: "fixed_parameters_no_training_or_optimization" as const,
    authority: { promotionEligible: false as const, brokerVerified: false as const, persistedExperiment: false as const },
    gapCount: gaps, partitions,
    limitations: [
      "Declared midpoint OHLC and source metadata are supplied inputs, not authenticated market provenance.",
      "Constant spread, adverse slippage and fee equivalents are explicit scenarios, not historical broker costs.",
      "Stop and target use modeled bid/ask quotes; target is market-on-touch, not a limit order. Dual-touch bars choose the stop; favorable target gaps receive no improvement.",
      "No tick order, intrabar timestamp, liquidity, partial fill, volume capacity, margin, borrow, funding, tax or currency model is supplied.",
      "Open outcomes remain unresolved. Marked P&L includes a hypothetical liquidation and exit fee, not a completed trade.",
      "Drawdown uses observed bar-close marks and completed outcomes only, not intrabar or entry-price excursions. Opening protective triggers precede a scheduled time exit; time exits precede later intrabar touches.",
      "Partitions run fixed parameters, start flat and may use prior bars for warmup. No optimization, unseen-holdout guarantee or statistical edge claim is made.",
      "Snapshots and hashes are frozen in memory, not persisted immutable experiment history; repeated trials and parameter selection are not audited.",
      "Price units per unit are not account currency; binary floating-point arithmetic remains. Existing stored backtests are not repaired or upgraded.",
    ],
  };
  return freezeResearch({ body, input, config });
}
export type PreparedResearch = ReturnType<typeof prepareCausalResearch>;
export function finalizeCausalResearch(prepared: PreparedResearch, fingerprints: ResearchResult["fingerprints"]): DeepReadonly<ResearchResult> {
  return freezeResearch({ ...prepared.body, inputSnapshot: prepared.input, configSnapshot: prepared.config, fingerprints });
}

/** Versioned EMA crossover strategy, using the same execution/accounting loop.
 * Reference OHLC stays in its declared BID or MID basis throughout. */
export function prepareCausalResearchV2(raw: ResearchV2Input, rawConfig: ResearchV2Config) {
  const { input, config, gaps } = snapshotV2(raw, rawConfig);
  const features = emaAtrFeatures(input.bars, config.strategy);
  const { trainEndExclusive: train, validationEndExclusive: validation } = config.splits;
  const partitions: ResearchV2Partition[] = [
    runPartition("train", 0, train, input, config, features),
    runPartition("validation", train, validation, input, config, features),
    runPartition("holdout", validation, input.bars.length, input, config, features),
  ].map(partition => {
    const trades = partition.trades.map(({ entryMid, exitMid, ...trade }) => ({ ...trade, entryReferencePrice: entryMid, exitReferencePrice: exitMid }));
    const openPosition = partition.openPosition ? (() => {
      const { entryMid, markMid, ...open } = partition.openPosition!;
      return { ...open, entryReferencePrice: entryMid, markReferencePrice: markMid };
    })() : null;
    return { ...partition, decisions: partition.decisions as ResearchV2Decision[], trades, openPosition };
  });
  const body = {
    engineVersion: RESEARCH_V2_ENGINE_VERSION, classification: "diagnostic" as const, verification: "unverified" as const,
    pnlUnit: "price_units_per_unit" as const, strategySelection: "fixed_parameters_no_training_or_optimization" as const,
    authority: { promotionEligible: false as const, brokerVerified: false as const, persistedExperiment: false as const },
    gapCount: gaps, partitions,
    limitations: [
      `Declared ${input.priceBasis} OHLC and source metadata are supplied inputs, not authenticated market provenance.`,
      input.priceBasis === "BID" ? "BID observations remain BID. Ask quotes are modeled as BID plus the explicit constant spread; no observed midpoint or ask history is claimed."
        : "MID observations remain MID. Bid and ask quotes are modeled at midpoint minus/plus half the explicit constant spread.",
      "EMA uses close prices and a full SMA seed; ATR uses first-bar high-low then true range with a full SMA seed and Wilder smoothing. Crossovers are observed only at a closed bar, with entries at the next observed open.",
      "ATR bracket distances are frozen at signal time and anchored to the modeled entry fill. Direction filtering does not reverse an existing position. No opposite-crossover exit is modeled.",
      "Constant spread, adverse slippage and fee equivalents are explicit scenarios, not historical broker costs.",
      "Stop and target use modeled liquidation-side quotes; target is market-on-touch, not a limit order. Dual-touch bars choose the stop; favorable target gaps receive no improvement.",
      "No tick order, intrabar timestamp, liquidity, partial fill, volume capacity, margin, borrow, funding, tax or currency model is supplied.",
      "Open outcomes remain unresolved. Marked P&L includes a hypothetical liquidation and exit fee, not a completed trade.",
      "Drawdown uses observed bar-close marks and completed outcomes only, not intrabar or entry-price excursions. Opening protective triggers precede a scheduled time exit; time exits precede later intrabar touches.",
      "Partitions run fixed parameters, start flat and may use prior bars for warmup. No optimization, unseen-holdout guarantee or statistical edge claim is made.",
      "Snapshots and hashes are frozen in memory, not persisted immutable experiment history; repeated trials and parameter selection are not audited. The v1 durable experiment store does not accept v2 results.",
      "Price units per unit are not account currency; binary floating-point arithmetic remains. Existing stored backtests are not repaired or upgraded.",
      ...(config.cash?[
        "Cash scenario v1 assumes a fully paid long-only asset with fixed quantity and explicit point value. This is not actual FX/CFD/futures financing, broker lots, leverage, contract metadata or currency conversion. Each partition restarts with its own capital.",
        "Entry affordability includes the modeled entry fill and fee. Unfunded signals are skipped without fees or delayed retries. Sale proceeds can be less than exit fees; negative cash/equity is retained, not clamped.",
        "Account equity is cash plus hypothetical net liquidation value at each observed close. Spread/slippage are already in fills; round-trip cost decomposition is not deducted twice. Closed-trade costs exclude unresolved-position costs.",
        "Same-quantity buy-and-hold attempts one buy at the first partition open using identical costs. An unaffordable benchmark remains flat cash; no smaller quantity or later entry is substituted. Its final mark is unresolved, not a completed sale. No dividends, interest or corporate adjustments are added.",
        "Annualized return is a historical equivalent rate shown only for positive terminal equity and at least 365.25 elapsed days. Close-observed drawdown does not measure worst intrabar loss."
      ]:[]),
    ],
  };
  return freezeResearch({ body, input, config });
}
export type PreparedResearchV2 = ReturnType<typeof prepareCausalResearchV2>;
export function finalizeCausalResearchV2(prepared: PreparedResearchV2, fingerprints: ResearchResult["fingerprints"]): DeepReadonly<ResearchV2Result> {
  return freezeResearch({ ...prepared.body, inputSnapshot: prepared.input, configSnapshot: prepared.config, fingerprints });
}
