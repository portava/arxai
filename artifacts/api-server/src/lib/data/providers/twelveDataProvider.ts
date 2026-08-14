import type { Candle, DataProvider, MarketQuote } from "../types.js";
import { mockProvider } from "./mockProvider.js";

// HONEST SHIM (Phase: Market Data Freshness).
//
// This file historically reported `isConnected: true` whenever a
// TWELVE_DATA_API_KEY env var was present, then returned `mockProvider`
// data anyway. That fake-positive is the root cause of the
// "connected as twelve_data but the data is stale" symptom the user
// reported: any caller of this layer (routes: multiTimeframe, data,
// watchlists) was shown a "connected" provider label backed by mock
// candles that never refreshed.
//
// Real TwelveData fetches live in
// `lib/assistant/marketProvider.ts` (scanner + assistant candle/quote
// path) where they participate in the real liveness/staleness model.
//
// This shim is now honest:
//   - name reflects that it is a mock shim, NOT a live provider
//   - isConnected() always returns false (no real fetch implemented here)
//   - getCandles / getQuote still return mockProvider output so existing
//     callers don't crash, but callers are responsible for treating
//     `isConnected()===false` as "no live source" in the UI.
export class TwelveDataProvider implements DataProvider {
  name = "twelveData_mock_shim";

  async getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    return mockProvider.getCandles(symbol, timeframe, limit);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    return mockProvider.getQuote(symbol);
  }

  async isConnected(): Promise<boolean> {
    return false;
  }
}

export const twelveDataProvider = new TwelveDataProvider();
