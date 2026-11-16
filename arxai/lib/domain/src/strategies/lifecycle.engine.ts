import type { Strategy, StrategyInput, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";
import type {
  StrategyLifecycle, StrategyAnalysis, SetupScore,
  ManageContext, ManageDecision, ExitDecision,
} from "./lifecycle.types";
import { computeTradeHealth } from "../trade/tradeHealth.engine";
import type { TradeSnapshot } from "../trade/trade.types";

// ── runLifecycle: drives the 3 pre-trade hooks in order ────────────────────
export function runLifecycle(lc: StrategyLifecycle, input: StrategyInput): {
  analysis: StrategyAnalysis;
  score: SetupScore;
  result: StrategyResult;
} {
  const analysis = lc.analyze(input);
  const score = lc.scoreSetup(input, analysis);
  if (!score.passed) {
    return {
      analysis, score,
      result: noSignal(lc.name, `Setup score ${score.score} < threshold ${score.threshold}`, ...score.reasons),
    };
  }
  const result = lc.generateSignal(input, analysis, score);
  return { analysis, score, result };
}

// ── composeLifecycle: turn a StrategyLifecycle into a plain Strategy ───────
// So a lifecycle implementation drops straight into STRATEGY_REGISTRY.
export function composeLifecycle(lc: StrategyLifecycle): Strategy {
  return {
    name: lc.name,
    label: lc.label,
    version: lc.version,
    evaluate(input) {
      return runLifecycle(lc, input).result;
    },
  };
}

// Build a TradeSnapshot from a ManageContext (computeTradeHealth's input shape)
function snapshotOf(ctx: ManageContext): TradeSnapshot {
  return {
    trade: ctx.trade,
    currentPrice: ctx.currentPrice,
    highSinceOpen: ctx.highSinceOpen,
    lowSinceOpen: ctx.lowSinceOpen,
    ageSeconds: ctx.ageSeconds,
  };
}

// ── Default manageTrade — generic, used when a strategy doesn't override ──
//   • health = CRITICAL                      → close fully
//   • R ≥ 2                                  → trail SL behind price by 1R
//   • health = AT_RISK and ≥1R locked        → partial close 50%
//   • R ≥ 1 and SL not yet at break-even     → move SL to break-even
//   • otherwise                              → HOLD
export function defaultManageTrade(ctx: ManageContext): ManageDecision {
  const { trade, strategyName } = ctx;
  const health = computeTradeHealth(snapshotOf(ctx));

  if (health.state === "CRITICAL") {
    return {
      strategyName, action: "FULL_CLOSE",
      reasons: [`Health CRITICAL (${health.score})`, ...health.reasons],
    };
  }

  if (health.rMultiple >= 2) {
    const trailDistance = Math.abs(trade.entryPrice - trade.stopLoss);
    const newSL = trade.direction === "BUY"
      ? ctx.currentPrice - trailDistance
      : ctx.currentPrice + trailDistance;
    return {
      strategyName, action: "TRAIL_SL", newStopLoss: newSL,
      reasons: [`R-multiple ${health.rMultiple.toFixed(2)} ≥ 2 → trail SL by 1R`],
    };
  }

  if (health.state === "AT_RISK" && health.rMultiple >= 1) {
    return {
      strategyName, action: "PARTIAL_CLOSE", partialFraction: 0.5,
      reasons: [`Health AT_RISK with ${health.rMultiple.toFixed(2)}R locked — derisk 50%`],
    };
  }

  if (health.rMultiple >= 1 && !isAtBreakEven(trade)) {
    return {
      strategyName, action: "MOVE_SL_TO_BREAKEVEN", newStopLoss: trade.entryPrice,
      reasons: [`R-multiple ${health.rMultiple.toFixed(2)} ≥ 1 → SL to break-even`],
    };
  }

  return {
    strategyName, action: "HOLD",
    reasons: [`Health ${health.state} (${health.score}), R ${health.rMultiple.toFixed(2)}`],
  };
}

function isAtBreakEven(trade: { entryPrice: number; stopLoss: number }): boolean {
  return Math.abs(trade.stopLoss - trade.entryPrice) < 1e-9;
}

// ── Default exitRules — generic, used when a strategy doesn't override ────
//   • SL or TP touched on the latest candle → SL_HIT / TP_HIT
//   • Trade older than 24h                  → TIME_STOP
export function defaultExitRules(ctx: ManageContext): ExitDecision {
  const last = ctx.candles[ctx.candles.length - 1];
  const { trade, strategyName } = ctx;
  if (!last) {
    return { strategyName, shouldExit: false, exitType: null, reasons: ["No candles"] };
  }

  if (trade.direction === "BUY") {
    if (last.low <= trade.stopLoss) {
      return exit(strategyName, "SL_HIT", `Low ${last.low} ≤ SL ${trade.stopLoss}`);
    }
    if (trade.takeProfit != null && last.high >= trade.takeProfit) {
      return exit(strategyName, "TP_HIT", `High ${last.high} ≥ TP ${trade.takeProfit}`);
    }
  } else {
    if (last.high >= trade.stopLoss) {
      return exit(strategyName, "SL_HIT", `High ${last.high} ≥ SL ${trade.stopLoss}`);
    }
    if (trade.takeProfit != null && last.low <= trade.takeProfit) {
      return exit(strategyName, "TP_HIT", `Low ${last.low} ≤ TP ${trade.takeProfit}`);
    }
  }

  if (ctx.ageSeconds > 24 * 60 * 60) {
    return exit(strategyName, "TIME_STOP", `Trade age ${(ctx.ageSeconds / 3600).toFixed(1)}h > 24h`);
  }

  return { strategyName, shouldExit: false, exitType: null, reasons: [] };
}

function exit(strategyName: string, type: ExitDecision["exitType"], reason: string): ExitDecision {
  return { strategyName, shouldExit: true, exitType: type, reasons: [reason] };
}

// ── Lift a plain Strategy → a full StrategyLifecycle using defaults ───────
// Useful for the existing 5 strategies until they each grow their own
// analyze/scoreSetup/manage/exit overrides.
export function liftStrategyToLifecycle(s: Strategy): StrategyLifecycle {
  return {
    name: s.name, label: s.label, version: s.version,

    analyze(input) {
      const result = s.evaluate(input);
      const bias = result.signal?.direction === "BUY" ? "BULLISH"
                 : result.signal?.direction === "SELL" ? "BEARISH"
                 : "NEUTRAL";
      return {
        strategyName: s.name, bias,
        conditions: [],     // lifted strategies don't expose granular conditions
        notes: result.emitted ? result.signal!.reasons : result.rejectedReasons,
      };
    },

    scoreSetup(input, _analysis) {
      const result = s.evaluate(input);
      const score = result.signal?.confidence ?? 0;
      return {
        strategyName: s.name, score,
        threshold: result.emitted ? score : 70,    // pass when signal was actually emitted
        passed: result.emitted,
        breakdown: [{ factor: "evaluate() confidence", earned: score, max: 100 }],
        reasons: result.emitted ? result.signal!.reasons : result.rejectedReasons,
      };
    },

    generateSignal(input, _analysis, _score) {
      return s.evaluate(input);
    },

    manageTrade: defaultManageTrade,
    exitRules:   defaultExitRules,
  };
}
