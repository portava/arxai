// Build TT — Simulated Live Market Engine.
//
// SAFETY: This is a synthetic price generator. It NEVER touches MT5,
// live_positions, mt5_commands, or placeLiveOrderGuarded(). Every quote
// is tagged executionEnvironment="SIMULATOR".
import { logger } from "./logger.js";

type Symbol = { symbol: string; baseCcy: string; quoteCcy: string; pip: number; spreadPips: number; basePrice: number };

const SYMBOLS: Symbol[] = [
  { symbol: "EURUSD", baseCcy: "EUR", quoteCcy: "USD", pip: 0.0001, spreadPips: 1.2, basePrice: 1.0850 },
  { symbol: "GBPUSD", baseCcy: "GBP", quoteCcy: "USD", pip: 0.0001, spreadPips: 1.5, basePrice: 1.2720 },
  { symbol: "USDJPY", baseCcy: "USD", quoteCcy: "JPY", pip: 0.01,   spreadPips: 1.4, basePrice: 156.30 },
  { symbol: "XAUUSD", baseCcy: "XAU", quoteCcy: "USD", pip: 0.10,   spreadPips: 30,  basePrice: 2380.0 },
  { symbol: "BTCUSDT", baseCcy: "BTC", quoteCcy: "USDT", pip: 1.0,  spreadPips: 5,   basePrice: 68500 },
  { symbol: "ETHUSDT", baseCcy: "ETH", quoteCcy: "USDT", pip: 0.1,  spreadPips: 8,   basePrice: 3450 },
  { symbol: "AAPL",   baseCcy: "AAPL", quoteCcy: "USD", pip: 0.01,  spreadPips: 2,   basePrice: 226.5 },
  { symbol: "TSLA",   baseCcy: "TSLA", quoteCcy: "USD", pip: 0.01,  spreadPips: 3,   basePrice: 248.0 },
];

type Quote = { symbol: string; bid: number; ask: number; spread: number; mid: number; tsIso: string; volatility: "LOW" | "MEDIUM" | "HIGH"; executionEnvironment: "SIMULATOR" };
type Candle = { tsIso: string; o: number; h: number; l: number; c: number; v: number };

class MarketSimulator {
  private prices = new Map<string, number>();
  private candles = new Map<string, Candle[]>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private startedAt: string | null = null;
  private volatility: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  constructor() {
    SYMBOLS.forEach(s => {
      this.prices.set(s.symbol, s.basePrice);
      this.candles.set(s.symbol, this.seedCandles(s));
    });
  }

  private seedCandles(s: Symbol): Candle[] {
    const out: Candle[] = [];
    let p = s.basePrice;
    const now = Date.now();
    for (let i = 60; i >= 1; i--) {
      const ts = new Date(now - i * 60_000);
      const drift = (Math.random() - 0.5) * s.pip * 5;
      const o = p; const c = o + drift;
      const h = Math.max(o, c) + Math.random() * s.pip * 2;
      const l = Math.min(o, c) - Math.random() * s.pip * 2;
      out.push({ tsIso: ts.toISOString(), o, h, l, c, v: Math.floor(Math.random() * 1000) });
      p = c;
    }
    return out;
  }

  private volMultiplier(): number {
    return this.volatility === "LOW" ? 0.5 : this.volatility === "HIGH" ? 2.5 : 1.0;
  }

  start(volatility?: "LOW" | "MEDIUM" | "HIGH") {
    if (volatility) this.volatility = volatility;
    if (this.running) return { running: true, alreadyRunning: true };
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.timer = setInterval(() => this.tick(), 1000);
    logger.info({ vol: this.volatility }, "marketSimulator started");
    return { running: true, alreadyRunning: false };
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info("marketSimulator stopped");
    return { running: false };
  }

  reset() {
    this.stop();
    SYMBOLS.forEach(s => {
      this.prices.set(s.symbol, s.basePrice);
      this.candles.set(s.symbol, this.seedCandles(s));
    });
    return { reset: true };
  }

  private tick() {
    const m = this.volMultiplier();
    SYMBOLS.forEach(s => {
      const cur = this.prices.get(s.symbol) ?? s.basePrice;
      const drift = (Math.random() - 0.5) * s.pip * 3 * m;
      const next = cur + drift;
      this.prices.set(s.symbol, next);
      const arr = this.candles.get(s.symbol)!;
      const last = arr[arr.length - 1]!;
      const lastTs = new Date(last.tsIso).getTime();
      const now = Date.now();
      if (now - lastTs > 60_000) {
        arr.push({ tsIso: new Date(now).toISOString(), o: cur, h: Math.max(cur, next), l: Math.min(cur, next), c: next, v: 1 });
        if (arr.length > 240) arr.shift();
      } else {
        last.c = next; last.h = Math.max(last.h, next); last.l = Math.min(last.l, next); last.v += 1;
      }
    });
  }

  symbols() { return SYMBOLS.map(s => ({ symbol: s.symbol, baseCcy: s.baseCcy, quoteCcy: s.quoteCcy, pip: s.pip, executionEnvironment: "SIMULATOR" as const })); }

  quote(symbol: string): Quote | null {
    const s = SYMBOLS.find(x => x.symbol === symbol.toUpperCase());
    if (!s) return null;
    const mid = this.prices.get(s.symbol) ?? s.basePrice;
    const spread = s.pip * s.spreadPips;
    return {
      symbol: s.symbol,
      bid: Number((mid - spread / 2).toFixed(5)),
      ask: Number((mid + spread / 2).toFixed(5)),
      spread: Number(spread.toFixed(5)),
      mid: Number(mid.toFixed(5)),
      tsIso: new Date().toISOString(),
      volatility: this.volatility,
      executionEnvironment: "SIMULATOR",
    };
  }

  candlesFor(symbol: string, limit = 60): Candle[] {
    const arr = this.candles.get(symbol.toUpperCase()) ?? [];
    return arr.slice(-limit);
  }

  sessionStatus() {
    const utcHour = new Date().getUTCHours();
    const session = utcHour < 7 ? "ASIA" : utcHour < 13 ? "LONDON" : utcHour < 21 ? "NEW_YORK" : "OFF";
    return {
      session,
      running: this.running,
      startedAt: this.startedAt,
      volatility: this.volatility,
      executionEnvironment: "SIMULATOR" as const,
      tsIso: new Date().toISOString(),
    };
  }

  setVolatility(v: "LOW" | "MEDIUM" | "HIGH") { this.volatility = v; return { volatility: v }; }
}

export const marketSimulator = new MarketSimulator();
// Auto-start with medium volatility so quotes are always available for the UI.
marketSimulator.start("MEDIUM");
