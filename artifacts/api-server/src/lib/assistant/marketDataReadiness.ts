import type { MarketProvider } from "./marketProvider.js";
import { classifyQuoteFreshness, classifyCandleFreshness } from "../data/freshness.js";

export async function inspectMarketData(provider: MarketProvider, symbol: string, now = Date.now) {
  const q = await provider.getLiveQuote(symbol);
  const c = await provider.getCandles(symbol, "M1", 10);
  const observedAt = now();
  const quoteMs = q.asOf ? Date.parse(q.asOf) : NaN;
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const quoteReady = q.symbol === symbol && q.freshness === "REALTIME" && !q.stale
    && classifyQuoteFreshness(observedAt - quoteMs).fresh && positive(q.price)
    && positive(q.bid) && positive(q.ask) && q.bid <= q.ask;
  const lastMs = c.candles.at(-1)?.t ? Date.parse(c.candles.at(-1)!.t) : NaN;
  const trailing = Number.isFinite(lastMs) ? Math.floor((observedAt - lastMs) / 60_000) : null;
  const candleReady = c.connected && c.freshness !== "UNAVAILABLE" && c.candles.length >= 10
    && classifyCandleFreshness(trailing)?.freshness === "clean"
    && c.candles.every((b, i, all) => {
      const t = Date.parse(b.t), prior = i ? Date.parse(all[i - 1]!.t) : null;
      return Number.isFinite(t) && t <= observedAt && (prior === null || t - prior === 60_000)
        && [b.o, b.h, b.l, b.c].every(positive) && b.h >= Math.max(b.o, b.c, b.l) && b.l <= Math.min(b.o, b.c, b.h);
    });
  return {
    scope: "Read-only development/release probe of one symbol and ten M1 bars; not broker execution or full-market certification.",
    observedAt: new Date(observedAt).toISOString(), provider: provider.name, symbol,
    ready: quoteReady && candleReady,
    quote: { ready: quoteReady, source: q.source, freshness: q.freshness, asOf: q.asOf,
      hasBid: positive(q.bid), hasAsk: positive(q.ask), stale: q.stale },
    candles: { ready: candleReady, source: c.source, freshness: c.freshness, asOf: c.asOf,
      count: c.candles.length, trailingIntervals: trailing },
  };
}
