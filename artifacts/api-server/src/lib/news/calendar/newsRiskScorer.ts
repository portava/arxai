import type { EconomicEvent } from "./economicEvents.js";

export interface NewsRisk {
  symbol: string;
  riskLevel: "none" | "low" | "medium" | "high";
  blockTrading: boolean;
  minutesUntilEvent: number | null;
  affectedSymbols: string[];
  reason: string;
  upcomingEvent: EconomicEvent | null;
  /**
   * Whether this verdict was derived from a KNOWN event set.
   *
   * `true`  — a connected calendar supplied the events (an empty list is then a
   *           real "no events in window" read), or the symbol is synthetic and
   *           genuinely unaffected by macro news.
   * `false` — no calendar provider is configured/reachable, so news risk is
   *           UNKNOWN. `riskLevel:"none"` on a `false` read means "we cannot
   *           see", NOT "clear" — never gate or reassure on it.
   */
  calendarAvailable: boolean;
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

/** Whether `symbol` is a synthetic index — genuinely unaffected by macro news. */
export function isSyntheticNewsSymbol(symbol: string): boolean {
  return SYNTHETIC.has(symbol);
}

/**
 * The honest "we cannot see the calendar" verdict. Carries no countdown, no
 * event and never blocks — the caller has NO event set, so any verdict beyond
 * "unknown" would be invented.
 */
export function newsRiskUnavailable(symbol: string, reason: string): NewsRisk {
  if (SYNTHETIC.has(symbol)) return scoreNewsRisk(symbol, []);
  return {
    symbol,
    riskLevel: "none",
    blockTrading: false,
    minutesUntilEvent: null,
    affectedSymbols: [],
    reason,
    upcomingEvent: null,
    calendarAvailable: false,
  };
}

/**
 * Score news risk for `symbol` against a KNOWN event set.
 *
 * `events` is REQUIRED and must come from a connected calendar (pass `[]` for a
 * connected-but-empty window). There is deliberately no default: the earlier
 * default pulled from the mock generator, so every caller that omitted the
 * argument received a fabricated FOMC/CPI/NFP schedule and could emit a
 * real-looking "trading blocked in 23m" verdict on an unconfigured deployment.
 * Callers with no provider must use `newsRiskUnavailable` (or the
 * newsRiskResolver) instead.
 */
export function scoreNewsRisk(symbol: string, events: EconomicEvent[]): NewsRisk {
  if (SYNTHETIC.has(symbol)) {
    return {
      symbol,
      riskLevel: "none",
      blockTrading: false,
      minutesUntilEvent: null,
      affectedSymbols: [],
      reason: "Synthetic volatility indices are unaffected by real-world news.",
      upcomingEvent: null,
      calendarAvailable: true,
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
      calendarAvailable: true,
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
    calendarAvailable: true,
  };
}
