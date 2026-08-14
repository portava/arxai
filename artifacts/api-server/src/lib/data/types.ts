export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MarketQuote {
  symbol: string;
  bid?: number;
  ask?: number;
  spread?: number;
  last?: number;
  timestamp: string;
}

export interface DataProvider {
  name: string;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<MarketQuote>;
  isConnected(): Promise<boolean>;
}

export type MarketType = "forex" | "index" | "stock" | "synthetic";

export const SUPPORTED_SYMBOLS: { symbol: string; marketType: MarketType }[] = [
  { symbol: "EURUSD", marketType: "forex" },
  { symbol: "GBPUSD", marketType: "forex" },
  { symbol: "USDJPY", marketType: "forex" },
  { symbol: "AUDUSD", marketType: "forex" },
  { symbol: "USDCAD", marketType: "forex" },
  { symbol: "EURJPY", marketType: "forex" },
  { symbol: "GBPJPY", marketType: "forex" },
  { symbol: "US30", marketType: "index" },
  { symbol: "NAS100", marketType: "index" },
  { symbol: "SPX500", marketType: "index" },
  { symbol: "AAPL", marketType: "stock" },
  { symbol: "TSLA", marketType: "stock" },
  { symbol: "MSFT", marketType: "stock" },
  { symbol: "Volatility 75 Index", marketType: "synthetic" },
  { symbol: "Volatility 75 1s Index", marketType: "synthetic" },
  { symbol: "Volatility 25 1s Index", marketType: "synthetic" },
];

export function getMarketType(symbol: string): MarketType {
  const found = SUPPORTED_SYMBOLS.find((s) => s.symbol === symbol);
  return found?.marketType ?? "synthetic";
}
