import type { Candle, DataProvider, MarketQuote } from "../types.js";

const BASE_PRICES: Record<string, number> = {
  EURUSD: 1.085,
  GBPUSD: 1.27,
  USDJPY: 152.4,
  AUDUSD: 0.66,
  USDCAD: 1.36,
  EURJPY: 165.2,
  GBPJPY: 193.4,
  US30: 38500,
  NAS100: 18200,
  SPX500: 5100,
  AAPL: 175,
  TSLA: 240,
  MSFT: 410,
  "Volatility 75 Index": 8000,
  "Volatility 75 1s Index": 8000,
  "Volatility 25 1s Index": 500,
};

const VOLATILITY: Record<string, number> = {
  EURUSD: 0.0008,
  GBPUSD: 0.001,
  USDJPY: 0.0012,
  AUDUSD: 0.001,
  USDCAD: 0.0009,
  EURJPY: 0.0014,
  GBPJPY: 0.0018,
  US30: 0.004,
  NAS100: 0.006,
  SPX500: 0.004,
  AAPL: 0.012,
  TSLA: 0.025,
  MSFT: 0.011,
  "Volatility 75 Index": 0.008,
  "Volatility 75 1s Index": 0.012,
  "Volatility 25 1s Index": 0.005,
};

// Deterministic pseudo-random per (symbol, second-bucket) so the
// mock data is stable across requests but evolves over time.
function seedRand(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export class MockProvider implements DataProvider {
  name = "mock";

  async getCandles(symbol: string, _timeframe: string, limit: number): Promise<Candle[]> {
    const base = BASE_PRICES[symbol] ?? 1000;
    const vol = VOLATILITY[symbol] ?? 0.005;
    const bucket = Math.floor(Date.now() / 60000);
    const rand = seedRand(bucket + symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0));
    let price = base;
    const candles: Candle[] = [];
    const now = Date.now();
    // Inject regime variation: trending → choppy → expansion → pullback → sweep
    for (let i = limit; i >= 0; i--) {
      const phase = Math.floor((limit - i) / Math.max(20, Math.floor(limit / 5))) % 5;
      let drift = 0;
      let extraVol = 1;
      if (phase === 0) drift = 0.0004; // trending up
      if (phase === 1) drift = 0; // chop
      if (phase === 2) extraVol = 2.2; // expansion
      if (phase === 3) drift = -0.0003; // pullback
      if (phase === 4) extraVol = 1.8; // sweep
      const open = price;
      const change = (rand() - 0.5 + drift) * price * vol * extraVol;
      const close = open + change;
      const wick = rand() * price * vol * extraVol * 0.6;
      const high = Math.max(open, close) + wick;
      const low = Math.min(open, close) - wick;
      const volume = Math.floor(rand() * 500 + 100);
      candles.push({
        time: new Date(now - i * 60000).toISOString(),
        open, high, low, close, volume,
      });
      price = close;
    }
    return candles;
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    const candles = await this.getCandles(symbol, "1m", 2);
    const last = candles[candles.length - 1];
    const spread = (BASE_PRICES[symbol] ?? 1000) * (VOLATILITY[symbol] ?? 0.005) * 0.05;
    return {
      symbol,
      bid: last.close - spread / 2,
      ask: last.close + spread / 2,
      last: last.close,
      spread,
      timestamp: new Date().toISOString(),
    };
  }

  async isConnected(): Promise<boolean> {
    return true;
  }
}

export const mockProvider = new MockProvider();
