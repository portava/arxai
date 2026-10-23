// (P) Build P — Testing Lab backtest equity/drawdown chart series (Task #763).
//
// DISPLAY-ONLY, DERIVED-NEVER-FABRICATED. This module turns a backtest run's
// already-stored per-trade rows into the equity-curve + drawdown + trade-marker
// series the Testing Lab renders. Every value is a deterministic function of the
// run's `initialBalance` and the trades' `profitLoss` — it composes the same
// cumulative-balance derivation the AI-review path already uses, and adds no new
// source of truth.
//
// SAFETY: pure, no DB / no network / no clock. It NEVER touches the live trade
// path, the simulator, or any gate. It can only describe historical results.

export interface BacktestChartTradeInput {
  direction: "BUY" | "SELL";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  profitLoss: number;
  rewardToRisk: number;
  result: string;
}

// Mirrors the frontend analytics `EquityPoint` shape so the existing
// EquityCurveChart / DrawdownChart components can render this directly.
export interface BacktestEquityPoint {
  tradeId: number;
  openedAt: string;
  equity: number;
  peak: number;
  drawdown: number;
}

export interface BacktestTradeMarker {
  tradeId: number;
  direction: "BUY" | "SELL";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  profitLoss: number;
  result: string;
}

export interface BacktestChartSeriesSummary {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  longNetProfitLoss: number;
  shortNetProfitLoss: number;
  bestTradeProfitLoss: number;
  worstTradeProfitLoss: number;
  netProfitLoss: number;
}

export interface BacktestChartSeries {
  kind: "BACKTEST";
  // Honest provenance label — this is settled historical simulation, never live.
  label: string;
  initialBalance: number;
  finalBalance: number;
  maxDrawdown: number;
  equity: BacktestEquityPoint[];
  markers: BacktestTradeMarker[];
  summary: BacktestChartSeriesSummary;
}

export const BACKTEST_SERIES_LABEL = "Historical simulation";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build the backtest equity/drawdown/marker series from a run's initial balance
 * and its per-trade rows. Trades are expected in chronological (entryTime) order
 * — the route reads them with `ORDER BY entryTime`. With zero trades the equity
 * array is empty (honest empty state) rather than a fabricated flat line.
 */
export function buildBacktestChartSeries(args: {
  initialBalance: number;
  trades: BacktestChartTradeInput[];
}): BacktestChartSeries {
  const { initialBalance, trades } = args;

  const equity: BacktestEquityPoint[] = [];
  const markers: BacktestTradeMarker[] = [];

  let balance = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;

  let longTrades = 0;
  let shortTrades = 0;
  let longNet = 0;
  let shortNet = 0;
  let bestTrade = trades.length ? -Infinity : 0;
  let worstTrade = trades.length ? Infinity : 0;

  if (trades.length > 0) {
    // Baseline anchor at the starting balance so the curve starts honestly at
    // initialBalance (drawdown 0) before the first trade resolves.
    equity.push({
      tradeId: 0,
      openedAt: trades[0]!.entryTime,
      equity: round2(initialBalance),
      peak: round2(initialBalance),
      drawdown: 0,
    });
  }

  trades.forEach((t, i) => {
    balance += t.profitLoss;
    if (balance > peak) peak = balance;
    const drawdown = Math.max(0, peak - balance);
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    equity.push({
      tradeId: i + 1,
      openedAt: t.exitTime,
      equity: round2(balance),
      peak: round2(peak),
      drawdown: round2(drawdown),
    });
    markers.push({
      tradeId: i + 1,
      direction: t.direction,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      profitLoss: round2(t.profitLoss),
      result: t.result,
    });

    if (t.direction === "BUY") { longTrades++; longNet += t.profitLoss; }
    else { shortTrades++; shortNet += t.profitLoss; }
    if (t.profitLoss > bestTrade) bestTrade = t.profitLoss;
    if (t.profitLoss < worstTrade) worstTrade = t.profitLoss;
  });

  return {
    kind: "BACKTEST",
    label: BACKTEST_SERIES_LABEL,
    initialBalance: round2(initialBalance),
    finalBalance: round2(balance),
    maxDrawdown: round2(maxDrawdown),
    equity,
    markers,
    summary: {
      totalTrades: trades.length,
      longTrades,
      shortTrades,
      longNetProfitLoss: round2(longNet),
      shortNetProfitLoss: round2(shortNet),
      bestTradeProfitLoss: round2(trades.length ? bestTrade : 0),
      worstTradeProfitLoss: round2(trades.length ? worstTrade : 0),
      netProfitLoss: round2(balance - initialBalance),
    },
  };
}
