import type { Candle, DataProvider, MarketQuote } from "../types.js";
import { mockProvider } from "./mockProvider.js";

export class AlphaVantageProvider implements DataProvider {
  name = "alphaVantage";

  private hasKey(): boolean {
    return !!process.env["ALPHA_VANTAGE_API_KEY"];
  }

  async getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    if (!this.hasKey()) return mockProvider.getCandles(symbol, timeframe, limit);
    // Real network call placeholder — disabled until the key is present and rate
    // limits are designed for. Falls back to mock so app keeps working.
    return mockProvider.getCandles(symbol, timeframe, limit);
  }

  async getQuote(symbol: string): Promise<MarketQuote> {
    if (!this.hasKey()) return mockProvider.getQuote(symbol);
    return mockProvider.getQuote(symbol);
  }

  async isConnected(): Promise<boolean> {
    return this.hasKey();
  }
}

export const alphaVantageProvider = new AlphaVantageProvider();
