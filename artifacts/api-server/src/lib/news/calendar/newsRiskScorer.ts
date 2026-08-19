import type { EconomicEvent } from "./economicEvents.js";
import { getMockEvents } from "./economicEvents.js";

export interface NewsRisk {
  symbol: string;
  riskLevel: "none" | "low" | "medium" | "high";
  blockTrading: boolean;
  minutesUntilEvent: number | null;
  affectedSymbols: string[];
  reason: string;
  upcomingEvent: EconomicEvent | null;
}

const SYMBOL_CURRENCIES: Record<string, string[]> = {
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
  USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"],
  USDCAD: ["USD", "CAD"],
  EURJPY: ["EUR", "JPY"],
  GBPJPY: ["GBP", "JPY"],
  US30: ["USD"],
  NAS100: ["USD"],
  SPX500: ["USD"],
  AAPL: ["USD"],
  TSLA: ["USD"],
  MSFT: ["USD"],
};

const SYNTHETIC = new Set([
  "Volatility 75 Index",
  "Volatility 75 1s Index",
  "Volatility 25 1s Index",
]);

export function scoreNewsRisk(symbol: string, events: EconomicEvent[] = getMockEvents(2)): NewsRisk {
  if (SYNTHETIC.has(symbol)) {
    return {
      symbol,
      riskLevel: "none",
      blockTrading: false,
      minutesUntilEvent: null,
      affectedSymbols: [],
      reason: "Synthetic volatility indices are unaffected by real-world news.",
      upcomingEvent: null,
    };
  }

  const currencies = SYMBOL_CURRENCIES[symbol] ?? [];
  const now = Date.now();

  const relevant = events.filter((e) =>
    currencies.includes(e.currency) || e.affectedMarkets.includes(symbol),
  );
  let nearest: EconomicEvent | null = null;
  let nearestMinutes = Infinity;
  for (const e of relevant) {
    const diff = (new Date(e.eventTime).getTime() - now) / 60000;
    if (diff > -15 && Math.abs(diff) < Math.abs(nearestMinutes)) {
      nearest = e;
      nearestMinutes = diff;
    }
  }

  if (!nearest) {
    return {
      symbol,
      riskLevel: "none",
      blockTrading: false,
      minutesUntilEvent: null,
      affectedSymbols: [],
      reason: "No relevant high-impact news in window.",
      upcomingEvent: null,
    };
  }

  const m = nearestMinutes;
  let riskLevel: NewsRisk["riskLevel"] = "low";
  let blockTrading = false;
  if (nearest.impact === "high") {
    if (m >= -15 && m <= 30) { blockTrading = true; riskLevel = "high"; }
    else if (m <= 90)        { riskLevel = "medium"; }
  } else if (nearest.impact === "medium") {
    if (m >= -5 && m <= 10) { blockTrading = true; riskLevel = "medium"; }
    else if (m <= 30)       { riskLevel = "low"; }
  }

  return {
    symbol,
    riskLevel,
    blockTrading,
    minutesUntilEvent: Math.round(m),
    affectedSymbols: nearest.affectedMarkets,
    reason: blockTrading
      ? `${nearest.impact.toUpperCase()} impact ${nearest.title} ${m >= 0 ? `in ${Math.round(m)}m` : `${Math.abs(Math.round(m))}m ago`} — trading blocked for ${symbol}.`
      : `${nearest.impact.toUpperCase()} impact ${nearest.title} ${m >= 0 ? `in ${Math.round(m)}m` : `${Math.abs(Math.round(m))}m ago`} — proceed with caution.`,
    upcomingEvent: nearest,
  };
}
