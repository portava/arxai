// (P) Build P — Backtesting & Strategy Validation Engine (pure domain).
//
// Inputs: historical candles + a signal-generator callback (the caller wires
// in the production strategy engine; the simulator stays pure and testable).
// Outputs: per-trade simulated rows + aggregated run metrics.
//
// Calculation choices:
//   - Simulates ONE position at a time (no pyramiding).
//   - Per-bar walk-forward: SL hit checked first (conservative), then TP.
//   - If neither hit by the end of the candle stream, position closes at last
//     close (status TIMEOUT). result is BREAKEVEN/WIN/LOSS by P&L sign.
//   - reward-to-risk computed at signal time as |TP-entry|/|entry-SL|.
//   - Profit/loss expressed in price-units × 1 (caller can scale by lot size
//     externally; absolute currency conversion is broker-specific).
//   - Drawdown computed from a running equity curve.
//
// SAFETY: pure, side-effect-free. Every aiSummary closes with the disclaimer
// "Past performance does not guarantee future results."

export * from "./evidence.js";
export * from "./format.js";
import { backtestDiagnosticSummary } from "./evidence.js";

export interface BacktestCandle {
  time: string;
  open: number; high: number; low: number; close: number;
  volume?: number;
}

export interface BacktestSignal {
  direction: "BUY" | "SELL" | "WAIT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  strategy: string;
}

export type SignalFn = (windowCandles: BacktestCandle[], idx: number) => BacktestSignal;

export interface BacktestSimTrade {
  symbol: string;
  direction: "BUY" | "SELL";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  profitLoss: number;
  rewardToRisk: number;
  result: "WIN" | "LOSS" | "BREAKEVEN" | "TIMEOUT";
}

export interface BacktestRunMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  netProfitLoss: number;
  maxDrawdown: number;
  winRate: number;            // 0..1
  averageRr: number;
  expectancy: number;         // (winRate × avgWin) − (lossRate × avgLoss)
  profitFactor: number;       // grossWins / |grossLosses| (Infinity if no losses)
  equityCurve: number[];
}

export interface BacktestSimulationResult {
  trades: BacktestSimTrade[];
  metrics: BacktestRunMetrics;
}

// Lookback window required before we'll ask for a signal. Keeps strategies
// that read indicators from the last ~50 candles working.
const MIN_LOOKBACK = 50;
// Cooldown bars between trades — prevents back-to-back re-entries on the
// same bar after a stop-out.
const TRADE_COOLDOWN_BARS = 3;

export function simulateBacktest(
  symbol: string,
  candles: BacktestCandle[],
  signalFn: SignalFn,
  initialBalance: number,
): BacktestSimulationResult {
  const trades: BacktestSimTrade[] = [];
  const equityCurve: number[] = [initialBalance];
  let equity = initialBalance;

  let openTrade: {
    direction: "BUY" | "SELL";
    entryTime: string; entryPrice: number;
    stopLoss: number; takeProfit: number;
  } | null = null;
  let cooldown = 0;

  for (let i = MIN_LOOKBACK; i < candles.length; i++) {
    const bar = candles[i]!;

    if (openTrade) {
      let exitPrice: number | null = null;
      let result: BacktestSimTrade["result"] | null = null;
      if (openTrade.direction === "BUY") {
        if (bar.low <= openTrade.stopLoss)        { exitPrice = openTrade.stopLoss;   result = "LOSS"; }
        else if (bar.high >= openTrade.takeProfit){ exitPrice = openTrade.takeProfit; result = "WIN"; }
      } else {
        if (bar.high >= openTrade.stopLoss)       { exitPrice = openTrade.stopLoss;   result = "LOSS"; }
        else if (bar.low  <= openTrade.takeProfit){ exitPrice = openTrade.takeProfit; result = "WIN"; }
      }
      if (exitPrice != null && result != null) {
        const pnl = openTrade.direction === "BUY"
          ? exitPrice - openTrade.entryPrice
          : openTrade.entryPrice - exitPrice;
        const slDist = Math.abs(openTrade.entryPrice - openTrade.stopLoss);
        const tpDist = Math.abs(openTrade.takeProfit - openTrade.entryPrice);
        const rr = slDist > 0 ? tpDist / slDist : 0;
        equity += pnl;
        equityCurve.push(equity);
        trades.push({
          symbol, direction: openTrade.direction,
          entryTime: openTrade.entryTime, exitTime: bar.time,
          entryPrice: openTrade.entryPrice, exitPrice,
          stopLoss: openTrade.stopLoss, takeProfit: openTrade.takeProfit,
          profitLoss: pnl, rewardToRisk: rr, result,
        });
        openTrade = null;
        cooldown = TRADE_COOLDOWN_BARS;
        continue;
      }
    }

    if (cooldown > 0) { cooldown--; continue; }

    if (!openTrade) {
      const window = candles.slice(0, i + 1);
      const sig = signalFn(window, i);
      if (sig.direction === "WAIT") continue;
      // Reject malformed signals defensively.
      const slValid = sig.direction === "BUY" ? sig.stopLoss < sig.entryPrice : sig.stopLoss > sig.entryPrice;
      const tpValid = sig.direction === "BUY" ? sig.takeProfit > sig.entryPrice : sig.takeProfit < sig.entryPrice;
      if (!slValid || !tpValid || sig.entryPrice <= 0) continue;
      openTrade = {
        direction: sig.direction,
        entryTime: bar.time, entryPrice: sig.entryPrice,
        stopLoss: sig.stopLoss, takeProfit: sig.takeProfit,
      };
    }
  }

  // Close any still-open trade at last close (TIMEOUT).
  if (openTrade && candles.length > 0) {
    const last = candles[candles.length - 1]!;
    const exitPrice = last.close;
    const pnl = openTrade.direction === "BUY"
      ? exitPrice - openTrade.entryPrice
      : openTrade.entryPrice - exitPrice;
    const slDist = Math.abs(openTrade.entryPrice - openTrade.stopLoss);
    const tpDist = Math.abs(openTrade.takeProfit - openTrade.entryPrice);
    const rr = slDist > 0 ? tpDist / slDist : 0;
    equity += pnl;
    equityCurve.push(equity);
    trades.push({
      symbol, direction: openTrade.direction,
      entryTime: openTrade.entryTime, exitTime: last.time,
      entryPrice: openTrade.entryPrice, exitPrice,
      stopLoss: openTrade.stopLoss, takeProfit: openTrade.takeProfit,
      profitLoss: pnl, rewardToRisk: rr,
      result: pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "TIMEOUT",
    });
  }

  return { trades, metrics: computeMetrics(trades, initialBalance, equityCurve) };
}

export function computeMetrics(
  trades: BacktestSimTrade[],
  initialBalance: number,
  equityCurve: number[],
): BacktestRunMetrics {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.profitLoss > 0);
  const losses = trades.filter((t) => t.profitLoss < 0);
  const winningTrades = wins.length;
  const losingTrades = losses.length;
  const netProfitLoss = trades.reduce((s, t) => s + t.profitLoss, 0);
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const grossWin = wins.reduce((s, t) => s + t.profitLoss, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profitLoss, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin  = winningTrades > 0 ? grossWin / winningTrades : 0;
  const avgLoss = losingTrades  > 0 ? grossLoss / losingTrades : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const averageRr = totalTrades > 0
    ? trades.reduce((s, t) => s + t.rewardToRisk, 0) / totalTrades
    : 0;

  // Max drawdown over equity curve.
  let peak = equityCurve[0] ?? initialBalance;
  let maxDrawdown = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades, winningTrades, losingTrades,
    netProfitLoss, maxDrawdown, winRate, averageRr,
    expectancy,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
    equityCurve,
  };
}

// Retained as a sample-size reference, never an evidence or readiness gate.
export const MIN_TRADES_FOR_VERIFICATION = 30;

export function isVerificationEligible(_m: { totalTrades: number; profitFactor: number }): boolean {
  // Counts and profit factor cannot prove provenance, execution realism,
  // chronological holdout isolation or experiment reproducibility.
  return false;
}

export function summarizeBacktest(opts: {
  strategyId: string; symbol: string; timeframe: string;
  metrics: BacktestRunMetrics;
  dataSource?: unknown;
}): string {
  return backtestDiagnosticSummary({ ...opts, ...opts.metrics });
}
