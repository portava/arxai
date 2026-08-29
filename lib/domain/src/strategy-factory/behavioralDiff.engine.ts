import { z } from "zod/v4";
import type { Strategy, StrategyInput, StrategyProposedSignal } from "../strategies/strategy.types";
import type { TradeDirection } from "../trade/trade.types";
import { isTradeSignal } from "./strategyContract.types";
import type { FrozenReplayDataset } from "./frozenReplay.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral diff — capability #14.
//
// Run TWO strategy versions over the SAME frozen replay dataset and report
// exactly how behavior changed: trade frequency, WAIT→trade / trade→WAIT
// flips, direction flips, stop & target moves, holding time, drawdown,
// costs, affected regimes — plus an exact per-frame changed-decision
// inventory. Deterministic: same dataset + same strategies ⇒ same report.
//
// Honesty rules
//   • Costs are computed ONLY when the dataset declares a cost model;
//     otherwise cost figures are null with a typed reason.
//   • A trade still open when the dataset ends has pnlR = null (outcome
//     OPEN_AT_END) — never a synthesized mark-to-market.
//   • A candle that touches BOTH stop and target in the same bar is scored
//     as STOP_HIT (pessimistic, deterministic) and the ambiguity is counted.
//   • The report is descriptive evidence for the owner. It grants nothing:
//     no promotion, no authority change, no execution path.
// ═══════════════════════════════════════════════════════════════════════════

export interface DecisionRecord {
  readonly frameIndex: number;
  readonly atIso: string;
  readonly emittedTrade: boolean;
  readonly action: string;             // BUY | SELL | WAIT | AVOID | NONE (no signal object)
  readonly direction: TradeDirection | null;
  readonly entry: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly confidence: number | null;
}

export const ChangeClassSchema = z.enum([
  "WAIT_TO_TRADE",       // baseline silent/WAIT/AVOID → candidate trades
  "TRADE_TO_WAIT",       // baseline trades → candidate silent/WAIT/AVOID
  "DIRECTION_FLIP",
  "STOP_MOVED",
  "TARGET_MOVED",
  "ENTRY_MOVED",
  "CONFIDENCE_SHIFT",
]);
export type ChangeClass = z.infer<typeof ChangeClassSchema>;

export interface ChangedDecision {
  readonly frameIndex: number;
  readonly atIso: string;
  readonly regime: string;
  readonly session: string;
  readonly classes: ChangeClass[];
  readonly baseline: DecisionRecord;
  readonly candidate: DecisionRecord;
}

export const TradeOutcomeSchema = z.enum(["STOP_HIT", "TARGET_HIT", "OPEN_AT_END"]);
export type TradeOutcome = z.infer<typeof TradeOutcomeSchema>;

export interface SimulatedTrade {
  readonly openedFrameIndex: number;
  readonly openedAtIso: string;
  readonly closedFrameIndex: number | null;
  readonly closedAtIso: string | null;
  readonly direction: TradeDirection;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly outcome: TradeOutcome;
  readonly ambiguousBar: boolean;      // stop AND target touched in the closing bar
  readonly pnlR: number | null;        // gross, in R (risk units); null when OPEN_AT_END
  readonly holdingMs: number | null;
  readonly costR: number | null;       // spread cost in R; null when no cost model
}

export interface VersionRunStats {
  readonly strategyName: string;
  readonly strategyVersion: string;
  readonly framesEvaluated: number;
  readonly signalsEmitted: number;             // frames where the strategy proposed a trade
  readonly tradeFrequencyPerFrame: number;     // signalsEmitted / framesEvaluated
  readonly simulatedTrades: SimulatedTrade[];  // sequential, non-overlapping
  readonly closedTrades: number;
  readonly stopHits: number;
  readonly targetHits: number;
  readonly openAtEnd: number;
  readonly ambiguousBars: number;
  readonly grossPnlR: number;                  // sum over CLOSED trades
  readonly maxDrawdownR: number;               // on the closed-trade gross equity curve
  readonly avgHoldingMs: number | null;        // null when no closed trades
  readonly avgStopDistance: number | null;     // price units, over emitted signals
  readonly avgConfidence: number | null;
  readonly totalCostR: number | null;          // null when dataset has no cost model
  readonly costReason: string | null;          // typed reason when totalCostR is null
}

export interface BehavioralDiffReport {
  readonly reportId: string;
  readonly generatedAtIso: string;
  readonly datasetId: string;
  readonly datasetHash: string | null;         // caller-provided; null = not computed
  readonly frameCount: number;
  readonly baseline: VersionRunStats;
  readonly candidate: VersionRunStats;
  readonly changedDecisions: ChangedDecision[];  // exact inventory, frame order
  readonly waitToTradeCount: number;
  readonly tradeToWaitCount: number;
  readonly directionFlipCount: number;
  readonly affectedRegimes: Record<string, number>;   // regime → changed-decision count
  readonly affectedSessions: Record<string, number>;
  readonly deltas: {
    readonly signalsEmitted: number;                  // candidate − baseline
    readonly tradeFrequencyPerFrame: number;
    readonly grossPnlR: number;
    readonly maxDrawdownR: number;
    readonly avgHoldingMs: number | null;             // null when either side lacks closed trades
    readonly totalCostR: number | null;
  };
  readonly notes: string[];
}

// ── Decision capture ────────────────────────────────────────────────────────
function recordDecision(frameIndex: number, input: StrategyInput, signal: StrategyProposedSignal | null): DecisionRecord {
  return {
    frameIndex,
    atIso: input.now.toISOString(),
    emittedTrade: isTradeSignal(signal),
    action: signal === null ? "NONE" : signal.action,
    direction: signal?.direction ?? null,
    entry: signal?.entry ?? null,
    stopLoss: signal?.stopLoss ?? null,
    takeProfit: signal?.takeProfit ?? null,
    confidence: signal?.confidence ?? null,
  };
}

function classifyChange(a: DecisionRecord, b: DecisionRecord): ChangeClass[] {
  const classes: ChangeClass[] = [];
  if (!a.emittedTrade && b.emittedTrade) classes.push("WAIT_TO_TRADE");
  if (a.emittedTrade && !b.emittedTrade) classes.push("TRADE_TO_WAIT");
  if (a.emittedTrade && b.emittedTrade) {
    if (a.direction !== b.direction) classes.push("DIRECTION_FLIP");
    if (numDiff(a.stopLoss, b.stopLoss)) classes.push("STOP_MOVED");
    if (numDiff(a.takeProfit, b.takeProfit)) classes.push("TARGET_MOVED");
    if (numDiff(a.entry, b.entry)) classes.push("ENTRY_MOVED");
    if (numDiff(a.confidence, b.confidence)) classes.push("CONFIDENCE_SHIFT");
  }
  return classes;
}

function numDiff(x: number | null, y: number | null): boolean {
  if (x === null && y === null) return false;
  if (x === null || y === null) return true;
  return Math.abs(x - y) > 1e-12;
}

// ── Sequential non-overlapping trade simulation ─────────────────────────────
// Mirrors a single-position engine: while a simulated trade is open, later
// signals are ignored. Exit checks use the NEWEST candle of each subsequent
// frame (the bar that formed after entry).
function simulate(
  decisions: DecisionRecord[],
  frames: ReadonlyArray<StrategyInput>,
  costRPerTrade: number | null,
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let i = 0;
  while (i < decisions.length) {
    const d = decisions[i];
    if (!d.emittedTrade || d.entry === null || d.stopLoss === null || d.takeProfit === null || d.direction === null) {
      i++;
      continue;
    }
    const dir = d.direction;
    const risk = Math.abs(d.entry - d.stopLoss);
    let closedAt: number | null = null;
    let outcome: TradeOutcome = "OPEN_AT_END";
    let ambiguous = false;

    for (let j = i + 1; j < frames.length; j++) {
      const bar = frames[j].candles[frames[j].candles.length - 1];
      const stopTouched = dir === "BUY" ? bar.low <= d.stopLoss : bar.high >= d.stopLoss;
      const targetTouched = dir === "BUY" ? bar.high >= d.takeProfit : bar.low <= d.takeProfit;
      if (stopTouched || targetTouched) {
        ambiguous = stopTouched && targetTouched;
        outcome = stopTouched ? "STOP_HIT" : "TARGET_HIT"; // both-touched ⇒ pessimistic STOP_HIT
        closedAt = j;
        break;
      }
    }

    const closed = closedAt !== null;
    const pnlR = !closed || risk <= 0
      ? null
      : outcome === "STOP_HIT" ? -1
      : Math.abs(d.takeProfit - d.entry) / risk;

    trades.push({
      openedFrameIndex: i,
      openedAtIso: d.atIso,
      closedFrameIndex: closedAt,
      closedAtIso: closedAt === null ? null : frames[closedAt].now.toISOString(),
      direction: dir,
      entry: d.entry,
      stopLoss: d.stopLoss,
      takeProfit: d.takeProfit,
      outcome,
      ambiguousBar: ambiguous,
      pnlR,
      holdingMs: closedAt === null ? null : frames[closedAt].now.getTime() - frames[i].now.getTime(),
      costR: costRPerTrade,
    });

    i = closedAt === null ? decisions.length : closedAt + 1;
  }
  return trades;
}

function maxDrawdown(pnls: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDd) maxDd = peak - equity;
  }
  return maxDd;
}

function runStats(
  strategy: Strategy,
  decisions: DecisionRecord[],
  dataset: FrozenReplayDataset,
): VersionRunStats {
  const emitted = decisions.filter((d) => d.emittedTrade);
  const stopDistances = emitted
    .filter((d) => d.entry !== null && d.stopLoss !== null)
    .map((d) => Math.abs((d.entry as number) - (d.stopLoss as number)));

  // Cost per trade in R: spread expressed as a fraction of the average stop
  // distance is trade-specific, so compute per trade from its own risk.
  const hasCosts = dataset.costModel !== null;
  const spreadPrice = hasCosts ? (dataset.costModel as { spreadPips: number }).spreadPips * dataset.pipSize : null;

  const trades = simulate(decisions, dataset.frames, null).map((t) => {
    if (spreadPrice === null) return t;
    const risk = Math.abs(t.entry - t.stopLoss);
    return { ...t, costR: risk > 0 ? spreadPrice / risk : null };
  });

  const closed = trades.filter((t) => t.pnlR !== null);
  const pnls = closed.map((t) => t.pnlR as number);
  const holds = closed.filter((t) => t.holdingMs !== null).map((t) => t.holdingMs as number);
  const confs = emitted.filter((d) => d.confidence !== null).map((d) => d.confidence as number);
  const costs = trades.map((t) => t.costR).filter((c): c is number => c !== null);

  return {
    strategyName: strategy.name,
    strategyVersion: strategy.version,
    framesEvaluated: decisions.length,
    signalsEmitted: emitted.length,
    tradeFrequencyPerFrame: decisions.length > 0 ? emitted.length / decisions.length : 0,
    simulatedTrades: trades,
    closedTrades: closed.length,
    stopHits: trades.filter((t) => t.outcome === "STOP_HIT").length,
    targetHits: trades.filter((t) => t.outcome === "TARGET_HIT").length,
    openAtEnd: trades.filter((t) => t.outcome === "OPEN_AT_END").length,
    ambiguousBars: trades.filter((t) => t.ambiguousBar).length,
    grossPnlR: pnls.reduce((a, b) => a + b, 0),
    maxDrawdownR: maxDrawdown(pnls),
    avgHoldingMs: holds.length > 0 ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    avgStopDistance: stopDistances.length > 0 ? stopDistances.reduce((a, b) => a + b, 0) / stopDistances.length : null,
    avgConfidence: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    totalCostR: hasCosts ? costs.reduce((a, b) => a + b, 0) : null,
    costReason: hasCosts ? null : "NO_COST_MODEL_IN_DATASET",
  };
}

// ── The diff ────────────────────────────────────────────────────────────────
export interface BehavioralDiffOptions {
  readonly now: Date;                 // injected clock — the engine stays pure
  readonly datasetHash?: string | null;
}

export function runBehavioralDiff(
  baseline: Strategy,
  candidate: Strategy,
  dataset: FrozenReplayDataset,
  opts: BehavioralDiffOptions,
): BehavioralDiffReport {
  const notes: string[] = [];
  const baseDecisions: DecisionRecord[] = [];
  const candDecisions: DecisionRecord[] = [];
  const changedDecisions: ChangedDecision[] = [];
  const affectedRegimes: Record<string, number> = {};
  const affectedSessions: Record<string, number> = {};

  dataset.frames.forEach((input, frameIndex) => {
    const b = recordDecision(frameIndex, input, baseline.evaluate(input).signal);
    const c = recordDecision(frameIndex, input, candidate.evaluate(input).signal);
    baseDecisions.push(b);
    candDecisions.push(c);
    const classes = classifyChange(b, c);
    if (classes.length > 0) {
      changedDecisions.push({
        frameIndex,
        atIso: input.now.toISOString(),
        regime: input.regime.regime,
        session: input.session.session,
        classes,
        baseline: b,
        candidate: c,
      });
      affectedRegimes[input.regime.regime] = (affectedRegimes[input.regime.regime] ?? 0) + 1;
      affectedSessions[input.session.session] = (affectedSessions[input.session.session] ?? 0) + 1;
    }
  });

  const baseStats = runStats(baseline, baseDecisions, dataset);
  const candStats = runStats(candidate, candDecisions, dataset);

  if (dataset.costModel === null) {
    notes.push("Dataset declares no cost model — cost figures are null (NO_COST_MODEL_IN_DATASET), not zero.");
  }
  const ambiguousTotal = baseStats.ambiguousBars + candStats.ambiguousBars;
  if (ambiguousTotal > 0) {
    notes.push(`${ambiguousTotal} simulated exit bar(s) touched both stop and target; scored pessimistically as STOP_HIT.`);
  }
  notes.push("Simulation is sequential/non-overlapping (single-position engine); overlapping signals are not double-counted.");
  notes.push("This report is descriptive evidence only. It changes no authority, promotes nothing, and opens no execution path.");

  const count = (cls: ChangeClass) => changedDecisions.filter((d) => d.classes.includes(cls)).length;

  return {
    reportId: `bdiff-${dataset.datasetId}-${baseline.name}@${baseline.version}-vs-${candidate.name}@${candidate.version}-${opts.now.getTime()}`,
    generatedAtIso: opts.now.toISOString(),
    datasetId: dataset.datasetId,
    datasetHash: opts.datasetHash ?? null,
    frameCount: dataset.frames.length,
    baseline: baseStats,
    candidate: candStats,
    changedDecisions,
    waitToTradeCount: count("WAIT_TO_TRADE"),
    tradeToWaitCount: count("TRADE_TO_WAIT"),
    directionFlipCount: count("DIRECTION_FLIP"),
    affectedRegimes,
    affectedSessions,
    deltas: {
      signalsEmitted: candStats.signalsEmitted - baseStats.signalsEmitted,
      tradeFrequencyPerFrame: candStats.tradeFrequencyPerFrame - baseStats.tradeFrequencyPerFrame,
      grossPnlR: candStats.grossPnlR - baseStats.grossPnlR,
      maxDrawdownR: candStats.maxDrawdownR - baseStats.maxDrawdownR,
      avgHoldingMs: candStats.avgHoldingMs !== null && baseStats.avgHoldingMs !== null
        ? candStats.avgHoldingMs - baseStats.avgHoldingMs : null,
      totalCostR: candStats.totalCostR !== null && baseStats.totalCostR !== null
        ? candStats.totalCostR - baseStats.totalCostR : null,
    },
    notes,
  };
}
