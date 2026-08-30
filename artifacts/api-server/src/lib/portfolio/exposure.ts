import type { Trade } from "@workspace/db";
import {
  resolveTradeScope,
  inScope,
  type ScopeMode,
} from "../performance/tradeScope.js";

export interface CurrencyExposure {
  currency: string;
  netLots: number;
}

export interface PortfolioExposure {
  totalOpen: number;
  totalClosed: number;
  /**
   * Unrealised P/L on OPEN positions, or null when no mark-to-market source
   * exists. `trades.pnl` is written ONLY at close — every writer in this repo
   * does — so summing it over OPEN rows produced a permanent, confident
   * "$0.00" on a page showing genuinely open positions. A missing read is a
   * typed null with a reason, never a reassuring zero.
   */
  floatingPnl: number | null;
  floatingPnlStatus: "NOT_MARKED_TO_MARKET" | "COMPUTED";
  realizedPnl: number;
  /** Closed rows dropped from realizedPnl because pnlStatus === "UNKNOWN". */
  realizedPnlExcludedUnknownCount: number;
  exposureByMarket: Record<string, number>;
  exposureByStrategy: Record<string, number>;
  exposureByCurrency: CurrencyExposure[];
  /**
   * NET realised P/L over the window. Deliberately NOT called "drawdown":
   * a day that ran +$500 then -$300 nets +$200, and the real $300 intraday
   * drawdown is invisible to a sum of closed P/L. Naming it "drawdown" made
   * a risk figure that could never fire.
   */
  netPnlToday: number;
  netPnlWeek: number;
  /** Which execution environment every figure above belongs to. */
  scopeMode: ScopeMode;
}

export interface CorrelationWarning {
  group: string;
  symbols: string[];
  direction: "BUY" | "SELL";
  netLots: number;
  message: string;
}

const PAIR_CURRENCIES: Record<string, [string, string]> = {
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
  AUDUSD: ["AUD", "USD"],
  USDJPY: ["USD", "JPY"],
  USDCAD: ["USD", "CAD"],
  USDCHF: ["USD", "CHF"],
  NZDUSD: ["NZD", "USD"],
  EURJPY: ["EUR", "JPY"],
  GBPJPY: ["GBP", "JPY"],
};

function marketTypeOf(symbol: string): string {
  if (PAIR_CURRENCIES[symbol]) return "Forex";
  if (["US30", "NAS100", "SPX500"].includes(symbol)) return "US Indices";
  if (["AAPL", "TSLA", "MSFT"].includes(symbol)) return "Stocks";
  if (symbol.startsWith("Volatility")) return "Synthetic";
  return "Other";
}

export function computeExposure(allTrades: Trade[]): PortfolioExposure {
  // Environment scoping — a real broker close and a simulator close never
  // land in the same total. See lib/performance/tradeScope.ts.
  const scope = resolveTradeScope(allTrades);
  const trades = inScope(allTrades, scope.mode);

  const open = trades.filter((t) => t.status === "OPEN");
  const closedAll = trades.filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");
  // pnlStatus="UNKNOWN" means the broker never reported a usable close fill.
  // Such a row contributed $0.00 to realizedPnl AND still counted as a
  // closed win/loss — an under-count presented as a complete figure.
  const excludedUnknown = closedAll.filter((t) => t.pnlStatus === "UNKNOWN");
  const closed = closedAll.filter((t) => t.pnlStatus !== "UNKNOWN");

  const exposureByMarket: Record<string, number> = {};
  const exposureByStrategy: Record<string, number> = {};
  const currencyMap = new Map<string, number>();

  for (const t of open) {
    const mt = marketTypeOf(t.symbol);
    exposureByMarket[mt] = (exposureByMarket[mt] ?? 0) + t.lot;
    exposureByStrategy[t.strategy] = (exposureByStrategy[t.strategy] ?? 0) + t.lot;
    const pair = PAIR_CURRENCIES[t.symbol];
    if (pair) {
      const sign = t.direction === "BUY" ? 1 : -1;
      currencyMap.set(pair[0], (currencyMap.get(pair[0]) ?? 0) + sign * t.lot);
      currencyMap.set(pair[1], (currencyMap.get(pair[1]) ?? 0) - sign * t.lot);
    }
  }

  const realized = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const dayMs = 86400000;
  const now = Date.now();
  const dailyTrades = closed.filter((t) => t.closedAt && now - new Date(t.closedAt).getTime() < dayMs);
  const weeklyTrades = closed.filter((t) => t.closedAt && now - new Date(t.closedAt).getTime() < 7 * dayMs);
  const netPnlToday = dailyTrades.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const netPnlWeek = weeklyTrades.reduce((a, t) => a + (t.pnl ?? 0), 0);

  return {
    totalOpen: open.length,
    totalClosed: closed.length,
    // No mark-to-market source exists on this path. Report the hole.
    floatingPnl: null,
    floatingPnlStatus: "NOT_MARKED_TO_MARKET",
    realizedPnl: realized,
    realizedPnlExcludedUnknownCount: excludedUnknown.length,
    exposureByMarket,
    exposureByStrategy,
    exposureByCurrency: [...currencyMap.entries()].map(([currency, netLots]) => ({ currency, netLots })),
    netPnlToday,
    netPnlWeek,
    scopeMode: scope.mode,
  };
}

export function detectCorrelationWarnings(allTrades: Trade[]): CorrelationWarning[] {
  // Same environment scope as computeExposure, so a warning never names a
  // position that the exposure panel beside it does not show.
  const trades = inScope(allTrades, resolveTradeScope(allTrades).mode);
  const open = trades.filter((t) => t.status === "OPEN");
  const warnings: CorrelationWarning[] = [];

  // Correlated USD-shorts via long EUR/USD, GBP/USD style
  const usdShortPairs = open.filter((t) => ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"].includes(t.symbol) && t.direction === "BUY");
  if (usdShortPairs.length >= 2) {
    warnings.push({
      group: "USD-short",
      symbols: usdShortPairs.map((t) => t.symbol),
      direction: "BUY",
      netLots: usdShortPairs.reduce((a, t) => a + t.lot, 0),
      message: "Multiple long pairs vs USD — concentrated USD-short exposure. One USD reversal hurts everything.",
    });
  }
  // US indices stacked
  const indices = open.filter((t) => ["US30", "NAS100", "SPX500"].includes(t.symbol));
  const indicesSameDir = indices.filter((t) => t.direction === indices[0]?.direction);
  if (indicesSameDir.length >= 2 && indices[0]) {
    warnings.push({
      group: "US Indices",
      symbols: indicesSameDir.map((t) => t.symbol),
      direction: indices[0].direction as "BUY" | "SELL",
      netLots: indicesSameDir.reduce((a, t) => a + t.lot, 0),
      message: "Multiple US indices in the same direction — these move together, your risk is doubled.",
    });
  }
  // JPY pairs same direction
  const jpyPairs = open.filter((t) => t.symbol.endsWith("JPY"));
  const jpySameDir = jpyPairs.filter((t) => t.direction === jpyPairs[0]?.direction);
  if (jpySameDir.length >= 2 && jpyPairs[0]) {
    warnings.push({
      group: "JPY pairs",
      symbols: jpySameDir.map((t) => t.symbol),
      direction: jpyPairs[0].direction as "BUY" | "SELL",
      netLots: jpySameDir.reduce((a, t) => a + t.lot, 0),
      message: "Multiple JPY pairs in the same direction — concentrated JPY exposure.",
    });
  }
  return warnings;
}
