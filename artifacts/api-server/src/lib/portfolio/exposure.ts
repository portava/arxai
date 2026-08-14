import type { Trade } from "@workspace/db";

export interface CurrencyExposure {
  currency: string;
  netLots: number;
}

export interface PortfolioExposure {
  totalOpen: number;
  totalClosed: number;
  floatingPnl: number;
  realizedPnl: number;
  exposureByMarket: Record<string, number>;
  exposureByStrategy: Record<string, number>;
  exposureByCurrency: CurrencyExposure[];
  dailyDrawdown: number;
  weeklyDrawdown: number;
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

export function computeExposure(trades: Trade[]): PortfolioExposure {
  const open = trades.filter((t) => t.status === "OPEN");
  const closed = trades.filter((t) => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS");

  const exposureByMarket: Record<string, number> = {};
  const exposureByStrategy: Record<string, number> = {};
  const currencyMap = new Map<string, number>();
  let floating = 0;

  for (const t of open) {
    const mt = marketTypeOf(t.symbol);
    exposureByMarket[mt] = (exposureByMarket[mt] ?? 0) + t.lot;
    exposureByStrategy[t.strategy] = (exposureByStrategy[t.strategy] ?? 0) + t.lot;
    floating += t.pnl ?? 0;
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
  const dailyDrawdown = Math.min(0, dailyTrades.reduce((a, t) => a + (t.pnl ?? 0), 0));
  const weeklyDrawdown = Math.min(0, weeklyTrades.reduce((a, t) => a + (t.pnl ?? 0), 0));

  return {
    totalOpen: open.length,
    totalClosed: closed.length,
    floatingPnl: floating,
    realizedPnl: realized,
    exposureByMarket,
    exposureByStrategy,
    exposureByCurrency: [...currencyMap.entries()].map(([currency, netLots]) => ({ currency, netLots })),
    dailyDrawdown,
    weeklyDrawdown,
  };
}

export function detectCorrelationWarnings(trades: Trade[]): CorrelationWarning[] {
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
