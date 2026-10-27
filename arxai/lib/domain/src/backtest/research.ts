import { createHash } from "node:crypto";

/** Server/offline-only, deterministic research. No broker, clock, database,
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
  disposition: "filled" | "gap_expired" | "invalid_bracket" | "partition_ended";
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
function fingerprint(value: unknown): string {
  // All hashed objects are reconstructed below in schema-defined key order;
  // caller object insertion order and extra fields never change semantics.
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function snapshots(raw: ResearchInput, config: ResearchConfig): { input: ResearchInput; config: ResearchConfig; gaps: number } {
  requireCondition(raw && config && config.strategy && config.costs && config.splits && raw.source, "MISSING_INPUT_OR_CONFIG");
  requireCondition(raw.priceBasis === "MID", "MID_PRICE_BASIS_REQUIRED");
  requireCondition(raw.source.kind === "generated" || raw.source.kind === "historical_unattested", "UNSUPPORTED_SOURCE");
  requireCondition(Array.isArray(raw.bars) && raw.bars.length > 0 && raw.bars.length <= MAX_RESEARCH_BARS, "BAR_COUNT_OUT_OF_BOUNDS");
  requireCondition(config.strategy.version === RESEARCH_STRATEGY_VERSION, "UNSUPPORTED_STRATEGY");
  const intervalMs = integer(raw.intervalMs, 1, 366 * 86400000, "INVALID_INTERVAL");
  const asOfMs = integer(raw.asOfMs, 1, 8_640_000_000_000_000, "INVALID_AS_OF");
  const costs = {
    fullSpreadPriceUnits: nonnegative(config.costs.fullSpreadPriceUnits, "INVALID_SPREAD"),
    adverseSlippagePerFillPriceUnits: nonnegative(config.costs.adverseSlippagePerFillPriceUnits, "INVALID_SLIPPAGE"),
    feePerFillPriceUnits: nonnegative(config.costs.feePerFillPriceUnits, "INVALID_FEE"),
  };
  finite(costs.fullSpreadPriceUnits + 2 * costs.adverseSlippagePerFillPriceUnits + 2 * costs.feePerFillPriceUnits, "COST_TOTAL_OVERFLOW");
  let previousClose = -1, gaps = 0;
  // Array.from visits sparse slots; Array.map would silently preserve holes.
  const bars = Array.from(raw.bars, bar => {
    requireCondition(bar, "MISSING_BAR");
    const openTimeMs = integer(bar.openTimeMs, 0, asOfMs - intervalMs, "BAR_NOT_CLOSED_AT_AS_OF");
    requireCondition(openTimeMs >= previousClose, "UNORDERED_DUPLICATE_OR_OVERLAPPING_BARS");
    if (previousClose >= 0 && openTimeMs > previousClose) gaps++;
    previousClose = openTimeMs + intervalMs;
    const open = positive(bar.open, "INVALID_OHLC"), high = positive(bar.high, "INVALID_OHLC"),
      low = positive(bar.low, "INVALID_OHLC"), close = positive(bar.close, "INVALID_OHLC");
    requireCondition(low <= open && low <= close && high >= open && high >= close && low <= high, "INCOHERENT_OHLC");
    requireCondition(low > costs.fullSpreadPriceUnits / 2 + costs.adverseSlippagePerFillPriceUnits, "NONPOSITIVE_MODELED_QUOTE");
    finite(high + costs.fullSpreadPriceUnits / 2 + costs.adverseSlippagePerFillPriceUnits, "QUOTE_OVERFLOW");
    return { openTimeMs, open, high, low, close };
  });
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
const direction = (side: ResearchSide) => side === "BUY" ? 1 : -1;

function runPartition(name: ResearchPartition["name"], from: number, to: number, input: ResearchInput, config: ResearchConfig): ResearchPartition {
  const { bars, intervalMs } = input, { strategy, costs } = config;
  const halfSpread = costs.fullSpreadPriceUnits / 2, slip = costs.adverseSlippagePerFillPriceUnits;
  const decisions: ResearchDecision[] = [], trades: ResearchTrade[] = [], markedCurve: ResearchPartition["markedCurve"] = [];
  let position: ResearchPosition | null = null, pending: ResearchDecision | null = null, exitNextOpen = false;
  let completedNet = 0, markedNet = 0, peak = 0, drawdown = 0;
  const exitPrice = (mid: number, side: ResearchSide) => finite(mid - direction(side) * (halfSpread + slip), "EXIT_PRICE_OVERFLOW");
  const netAt = (p: ResearchPosition, mid: number) => finite(direction(p.side) * (exitPrice(mid, p.side) - p.entryPrice) - 2 * costs.feePerFillPriceUnits, "PNL_OVERFLOW");
  for (let i = from; i < to; i++) {
    const bar = bars[i]!;
    if (pending) {
      if (bar.openTimeMs - pending.knownThroughMs > config.maxEntryGapMs) pending.disposition = "gap_expired";
      else {
        const sign = direction(pending.side), entryPrice = finite(bar.open + sign * (halfSpread + slip), "ENTRY_PRICE_OVERFLOW");
        const stopPrice = finite(entryPrice - sign * strategy.stopDistancePriceUnits, "BRACKET_OVERFLOW");
        const targetPrice = finite(entryPrice + sign * strategy.targetDistancePriceUnits, "BRACKET_OVERFLOW");
        if (stopPrice <= 0 || targetPrice <= 0) pending.disposition = "invalid_bracket";
        else {
          pending.disposition = "filled"; pending.entryIndex = i;
          position = { signalIndex: pending.signalIndex, entryIndex: i, side: pending.side,
            entryTimeMs: bar.openTimeMs, entryMid: bar.open, entryPrice, stopPrice, targetPrice };
        }
      }
      pending = null;
    }
    if (position) {
      const p = position, sign = direction(p.side);
      const bidAskShift = -sign * halfSpread;
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
        position = null; exitNextOpen = false;
      } else if (i - p.entryIndex + 1 >= strategy.maxHoldingBars) exitNextOpen = true;
    }
    // Only current/past closed observations are read. There is no user callback
    // with access to the dataset, no fitted parameter, and no future index here.
    if (!position && i >= strategy.lookbackBars) {
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
  return { name, fromInclusive: from, toExclusive: to, decisions, trades, openPosition,
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
export function runCausalResearch(raw: ResearchInput, rawConfig: ResearchConfig): DeepReadonly<ResearchResult> {
  const { input, config, gaps } = snapshots(raw, rawConfig);
  const strategyHash = fingerprint([RESEARCH_ENGINE_VERSION, config.strategy]);
  const inputHash = fingerprint([RESEARCH_ENGINE_VERSION, input]);
  const configHash = fingerprint([RESEARCH_ENGINE_VERSION, config]);
  const { trainEndExclusive: train, validationEndExclusive: validation } = config.splits;
  const partitions = [runPartition("train", 0, train, input, config),
    runPartition("validation", train, validation, input, config), runPartition("holdout", validation, input.bars.length, input, config)];
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
  const resultHash = fingerprint([inputHash, configHash, strategyHash, body]);
  return freeze({ ...body, inputSnapshot: input, configSnapshot: config,
    fingerprints: { algorithm: "sha256", input: inputHash, configuration: configHash, strategy: strategyHash, result: resultHash } });
}
