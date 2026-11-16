// Convert app symbols to broker / API symbols.
const MAP_TWELVE_DATA: Record<string, string> = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  AUDUSD: "AUD/USD",
  USDCAD: "USD/CAD",
  EURJPY: "EUR/JPY",
  GBPJPY: "GBP/JPY",
  US30: "DJI",
  NAS100: "IXIC",
  SPX500: "SPX",
};

const MAP_ALPHA_VANTAGE: Record<string, string> = {
  EURUSD: "EURUSD",
  GBPUSD: "GBPUSD",
  USDJPY: "USDJPY",
  US30: "DJI",
  NAS100: "IXIC",
  SPX500: "SPX",
};

const MAP_MT5: Record<string, string> = {
  US30: "US30.cash",
  NAS100: "NAS100.cash",
  SPX500: "SPX500.cash",
};

export function toTwelveDataSymbol(symbol: string): string {
  return MAP_TWELVE_DATA[symbol] ?? symbol;
}

export function toAlphaVantageSymbol(symbol: string): string {
  return MAP_ALPHA_VANTAGE[symbol] ?? symbol;
}

export function toMt5Symbol(symbol: string): string {
  return MAP_MT5[symbol] ?? symbol;
}
