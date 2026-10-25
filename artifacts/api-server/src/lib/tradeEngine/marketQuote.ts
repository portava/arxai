// Shared real-quote admission for market-priced PAPER opens and closes.
import { getMarketData } from "../marketData/marketDataService.js";

/** A current, real quote for the symbol, or the reasons there is none. */
export async function currentQuote(symbol: string): Promise<
  { ok: true; bid: number; ask: number; at: Date; source: string } | { ok: false; reasons: string[] }
> {
  let md: Awaited<ReturnType<typeof getMarketData>>;
  try {
    md = await getMarketData({ symbol, timeframe: "M5", limit: 100 });
  } catch (err) {
    return { ok: false, reasons: [`market data unavailable: ${String(err).slice(0, 120)}`] };
  }
  const { snapshot, blockers } = md;
  const reasons = blockers.filter((b) => b.blocked && (b.severity === "CRITICAL" || b.severity === "HIGH")).map((b) => b.reason);
  const at = new Date(snapshot.timestamp);
  if (snapshot.source !== "REAL") reasons.push(`price source is ${snapshot.source}, not a real provider`);
  if (!Number.isFinite(snapshot.bid) || !Number.isFinite(snapshot.ask) || snapshot.bid <= 0 || snapshot.ask <= 0) reasons.push("no valid bid/ask");
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now()) reasons.push("quote has no valid observation time");
  if (snapshot.bid > snapshot.ask) reasons.push("crossed bid/ask");
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, bid: snapshot.bid, ask: snapshot.ask, at, source: `${snapshot.source}:${snapshot.provider}` };
}

