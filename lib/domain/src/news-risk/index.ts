// (N) Build N — News & Economic Calendar Risk Filter (pure domain).
//
// Inputs are economic event records normalized into a small shape. Output is
// a risk report for a given symbol: label, time-until-event, warning text,
// AI summary. Rules per spec:
//   - HIGH-impact within 15 min       → NO_TRADE_WINDOW
//   - CRITICAL impact (any time +/- window) → NO_TRADE_WINDOW
//   - HIGH-impact within 60 min       → HIGH_RISK
//   - MEDIUM-impact within 30 min     → CAUTION
//   - Volatility flag (actual vs forecast deviates heavily) → CAUTION min
//   - Otherwise                       → CLEAR
//
// SAFETY: the engine never claims certainty. AI summaries always close with
// the live-execution disclaimer. Synthetic indices (Volatility 75 etc.) are
// unaffected by macro news — return CLEAR with explanatory reason.

export type ImpactLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type NewsRiskLabel = "CLEAR" | "CAUTION" | "HIGH_RISK" | "NO_TRADE_WINDOW";

export interface EconomicEventInput {
  id: number;
  eventName: string;
  currency: string;
  impactLevel: ImpactLevel;
  eventTimeIso: string;
  forecast?: string | null;
  actual?: string | null;
  volatilityFlag?: boolean;
  affectedSymbols?: string[] | null;
}

export interface NewsRiskResult {
  symbol: string;
  riskLevel: NewsRiskLabel;
  blockTrading: boolean;                   // true iff NO_TRADE_WINDOW
  timeUntilEventMinutes: number | null;    // signed; negative = past
  relatedCurrency: string | null;
  event: EconomicEventInput | null;
  tradeWarning: string | null;
  aiSummary: string;
  reasons: string[];
}

// ── Symbol → currency map (mirrors existing news lib for back-compat) ───
const SYMBOL_CURRENCIES: Record<string, string[]> = {
  EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], EURJPY: ["EUR", "JPY"],
  GBPJPY: ["GBP", "JPY"],
  US30: ["USD"], NAS100: ["USD"], SPX500: ["USD"],
  AAPL: ["USD"], TSLA: ["USD"], MSFT: ["USD"],
};
// Synthetic indices come in many naming variants. We match prefixes (Deriv's
// canonical "Volatility 75 Index") *and* short aliases (Vol75, V75, R_75,
// JD25, Crash500, Boom1000, Step Index, RB100, etc.). Any of these are
// macro-news-immune so news risk is always CLEAR with the synthetic reason.
const SYNTHETIC_PREFIX_RE = /^(Volatility|Crash|Boom|Step|Jump|Range Break|Bull Market|Bear Market|DEX|Drift Switch|Multi Step|Daily Reset)\b/i;
const SYNTHETIC_ALIAS_RE  = /^(Vol|V|R_|JD|RB|HZ)\d+/i;

export function isSynthetic(symbol: string): boolean {
  return SYNTHETIC_PREFIX_RE.test(symbol) || SYNTHETIC_ALIAS_RE.test(symbol);
}

export function relatedCurrenciesFor(symbol: string): string[] {
  return SYMBOL_CURRENCIES[symbol] ?? [];
}

// ── Volatility heuristic: actual vs forecast >50% relative delta ───────
export function detectVolatilitySpike(actual: string | null | undefined, forecast: string | null | undefined): boolean {
  if (!actual || !forecast) return false;
  const a = parseFloat(actual.replace(/[^0-9.\-]/g, ""));
  const f = parseFloat(forecast.replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(f)) return false;
  if (f === 0) return Math.abs(a) > 0;
  return Math.abs((a - f) / f) > 0.5;
}

// ── Core scorer ─────────────────────────────────────────────────────────
export function scoreNewsRisk(args: {
  symbol: string;
  events: EconomicEventInput[];
  nowMs?: number;
}): NewsRiskResult {
  const { symbol } = args;
  const now = args.nowMs ?? Date.now();
  const reasons: string[] = [];

  if (isSynthetic(symbol)) {
    return {
      symbol, riskLevel: "CLEAR", blockTrading: false,
      timeUntilEventMinutes: null, relatedCurrency: null, event: null,
      tradeWarning: null,
      aiSummary: `${symbol} is a synthetic volatility index — unaffected by macro news. Risk: CLEAR. This is not a guarantee, gated by live-execution safety layer.`,
      reasons: ["Synthetic index — macro news does not apply."],
    };
  }

  const currencies = relatedCurrenciesFor(symbol);
  // Filter relevant events: matches a related currency OR explicitly includes symbol.
  const relevant = args.events.filter((e) =>
    currencies.includes(e.currency)
    || (e.affectedSymbols ? e.affectedSymbols.includes(symbol) : false)
  );

  // Pick the most-impactful event in the look-ahead window. For ties,
  // prefer the soonest. We look at +/- 120 min so recent-past events still
  // surface as "just released" warnings.
  const WINDOW_MIN = 120;
  let chosen: { event: EconomicEventInput; deltaMin: number } | null = null;
  for (const e of relevant) {
    const deltaMin = (new Date(e.eventTimeIso).getTime() - now) / 60000;
    if (deltaMin < -WINDOW_MIN || deltaMin > 24 * 60) continue;
    if (!chosen) { chosen = { event: e, deltaMin }; continue; }
    const impactRank = (lvl: ImpactLevel) => ({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[lvl]);
    const cur = chosen.event;
    if (impactRank(e.impactLevel) > impactRank(cur.impactLevel)
        || (impactRank(e.impactLevel) === impactRank(cur.impactLevel)
            && Math.abs(deltaMin) < Math.abs(chosen.deltaMin))) {
      chosen = { event: e, deltaMin };
    }
  }

  if (!chosen) {
    return {
      symbol, riskLevel: "CLEAR", blockTrading: false,
      timeUntilEventMinutes: null,
      relatedCurrency: currencies[0] ?? null,
      event: null, tradeWarning: null,
      aiSummary: `No relevant economic events in the next 24h or last 2h for ${symbol}. Risk: CLEAR. This is not a guarantee, gated by live-execution safety layer.`,
      reasons: ["No relevant events in window."],
    };
  }

  const { event, deltaMin } = chosen;
  const minutesAbs = Math.abs(deltaMin);
  const directionWord = deltaMin >= 0 ? `in ${Math.round(minutesAbs)}m` : `${Math.round(minutesAbs)}m ago`;
  let label: NewsRiskLabel = "CLEAR";

  // Rule application order — first match wins.
  if (event.impactLevel === "CRITICAL") {
    label = "NO_TRADE_WINDOW";
    reasons.push(`CRITICAL impact event ${event.eventName} — no-trade window enforced.`);
  } else if (event.impactLevel === "HIGH" && deltaMin >= -15 && deltaMin <= 15) {
    label = "NO_TRADE_WINDOW";
    reasons.push(`HIGH impact ${event.eventName} ${directionWord} — within 15-minute no-trade window.`);
  } else if (event.impactLevel === "HIGH" && deltaMin > 15 && deltaMin <= 60) {
    label = "HIGH_RISK";
    reasons.push(`HIGH impact ${event.eventName} ${directionWord} — within 60-minute high-risk window.`);
  } else if (event.impactLevel === "MEDIUM" && deltaMin >= -10 && deltaMin <= 30) {
    label = "CAUTION";
    reasons.push(`MEDIUM impact ${event.eventName} ${directionWord} — caution window.`);
  } else if (event.volatilityFlag) {
    label = "CAUTION";
    reasons.push(`${event.eventName} actual differed heavily from forecast — elevated volatility risk.`);
  } else {
    label = "CLEAR";
    reasons.push(`Nearest relevant event (${event.eventName} ${directionWord}, impact ${event.impactLevel}) is outside risk windows.`);
  }

  // Volatility flag escalates CLEAR → CAUTION but never reduces severity.
  if (event.volatilityFlag && label === "CLEAR") {
    label = "CAUTION";
    reasons.push("Volatility flag set on the nearest event.");
  }

  const blockTrading = label === "NO_TRADE_WINDOW";
  const tradeWarning = label === "CLEAR"
    ? null
    : `${label.replace(/_/g, " ")}: ${event.impactLevel} impact ${event.eventName} (${event.currency}) ${directionWord}. ${blockTrading ? "Trading blocked for this symbol while the no-trade window is active." : "Proceed with elevated caution — consider reducing size or waiting."}`;

  // AI summary always carries the disclaimer.
  const aiSummary = `${symbol}: ${event.impactLevel} impact "${event.eventName}" (${event.currency}) ${directionWord}. Risk: ${label.replace(/_/g, " ")}.${tradeWarning ? ` ${tradeWarning}` : ""} This is not a guarantee, gated by live-execution safety layer.`;

  return {
    symbol,
    riskLevel: label,
    blockTrading,
    timeUntilEventMinutes: Math.round(deltaMin),
    relatedCurrency: event.currency,
    event,
    tradeWarning,
    aiSummary,
    reasons,
  };
}
