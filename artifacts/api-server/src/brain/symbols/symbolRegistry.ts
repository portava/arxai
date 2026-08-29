// D3b — this registry is now a VIEW over the Instrument Passport
// (`@workspace/domain/market` instrumentPassport.ts) for every symbol that
// resolves to an approved ARX Focus market: the passport facts (broker/venue
// symbol, base/quote currency) are read through the passport at module build
// via `alignWithPassport` below, so this file can no longer carry a divergent
// copy of them. The advisory metadata (risk level, sessions, timeframes,
// confidence, notes) remains authored here — the passport does not own it.
// Symbols with no passport (stocks, NAS100/UK100/JP225 — outside the approved
// Focus universe) keep their literal values. Drift is locked by
// `test:instrument-passport-drift`.
import { resolveInstrumentPassport, venueCodeSymbol } from "@workspace/domain/market";

export interface SymbolInfo {
  displayName: string;
  category: "forex" | "indices" | "stocks" | "synthetic";
  brokerSymbol: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  riskLevel: "Low" | "Medium" | "Medium-High" | "High" | "Very High";
  tradingSessions: Array<"Asia" | "London" | "New York" | "London/NY Overlap" | "24/7">;
  recommendedTimeframes: string[];
  minimumConfidence: number;
  defaultRiskPerTrade: number;
  notes: string;
}

/**
 * Read passport facts through the canonical Instrument Passport when the key
 * resolves to an approved market. The venue symbol prefers the key's own
 * canonical spelling when the passport lists it as a venue symbol (US30 stays
 * US30), else the passport's code-like venue id (V75 → R_75).
 */
function alignWithPassport(registryKey: string, info: SymbolInfo): SymbolInfo {
  const pp = resolveInstrumentPassport(registryKey);
  if (!pp) return info;
  const canonicalIsVenue = pp.venueSymbols.some(
    (v) => v.toUpperCase() === pp.canonicalSymbol.toUpperCase(),
  );
  const brokerSymbol = canonicalIsVenue ? pp.canonicalSymbol : venueCodeSymbol(pp);
  return {
    ...info,
    brokerSymbol,
    baseCurrency: pp.baseCurrency.value ?? info.baseCurrency,
    quoteCurrency: pp.quoteCurrency.value ?? info.quoteCurrency,
  };
}

const AUTHORED_SYMBOL_REGISTRY: Record<string, SymbolInfo> = {
  // ─── Forex Majors ─────────────────────────────────────────────────────────
  EURUSD: { displayName: "EUR/USD", category: "forex", brokerSymbol: "EURUSD", baseCurrency: "EUR", quoteCurrency: "USD", riskLevel: "Medium", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "World's most traded pair. High liquidity, tight spreads. Moves on ECB/Fed policy. Best during London/NY overlap." },
  GBPUSD: { displayName: "GBP/USD", category: "forex", brokerSymbol: "GBPUSD", baseCurrency: "GBP", quoteCurrency: "USD", riskLevel: "Medium", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Cable. Higher volatility than EUR/USD. Sensitive to UK data and BoE policy. Wide spreads at Asia open." },
  USDJPY: { displayName: "USD/JPY", category: "forex", brokerSymbol: "USDJPY", baseCurrency: "USD", quoteCurrency: "JPY", riskLevel: "Medium", tradingSessions: ["Asia", "London", "New York"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Dollar-Yen. Moves across all sessions. Sensitive to Fed/BoJ divergence. Watch Tokyo fix (04:55 UTC). BoJ intervention risk above 155." },
  USDCHF: { displayName: "USD/CHF", category: "forex", brokerSymbol: "USDCHF", baseCurrency: "USD", quoteCurrency: "CHF", riskLevel: "Medium", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Swissy. Inversely correlated with EUR/USD. CHF is safe haven, flows to CHF during risk-off events." },
  USDCAD: { displayName: "USD/CAD", category: "forex", brokerSymbol: "USDCAD", baseCurrency: "USD", quoteCurrency: "CAD", riskLevel: "Medium", tradingSessions: ["London/NY Overlap", "New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Loonie. Highly correlated with crude oil price. Most liquid during New York session. Watch WTI oil for direction." },
  AUDUSD: { displayName: "AUD/USD", category: "forex", brokerSymbol: "AUDUSD", baseCurrency: "AUD", quoteCurrency: "USD", riskLevel: "Medium", tradingSessions: ["Asia", "London", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Aussie. Risk-on currency. Tracks China economic data and commodity prices. Most active in Asia/London overlap." },
  NZDUSD: { displayName: "NZD/USD", category: "forex", brokerSymbol: "NZDUSD", baseCurrency: "NZD", quoteCurrency: "USD", riskLevel: "Medium", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 65, defaultRiskPerTrade: 1, notes: "Kiwi. Smaller economy pair. Correlated with AUD/USD. Dairy prices and RBNZ policy are key drivers." },
  // ─── Forex Minors ─────────────────────────────────────────────────────────
  EURGBP: { displayName: "EUR/GBP", category: "forex", brokerSymbol: "EURGBP", baseCurrency: "EUR", quoteCurrency: "GBP", riskLevel: "Medium-High", tradingSessions: ["London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "European cross. Ranges for long periods. Watch ECB vs BoE divergence. Quiet most of Asia session." },
  EURJPY: { displayName: "EUR/JPY", category: "forex", brokerSymbol: "EURJPY", baseCurrency: "EUR", quoteCurrency: "JPY", riskLevel: "Medium-High", tradingSessions: ["Asia", "London", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "High volatility cross. Combines EUR weakness and JPY weakness. Risk barometer — falls sharply on risk-off." },
  EURCHF: { displayName: "EUR/CHF", category: "forex", brokerSymbol: "EURCHF", baseCurrency: "EUR", quoteCurrency: "CHF", riskLevel: "Medium-High", tradingSessions: ["London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "European safe-haven cross. Prone to sharp drops during risk-off. Low volatility normally, can spike violently." },
  EURAUD: { displayName: "EUR/AUD", category: "forex", brokerSymbol: "EURAUD", baseCurrency: "EUR", quoteCurrency: "AUD", riskLevel: "Medium-High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Higher spread cross. Diverges on ECB vs RBA policy. Commodity-linked via AUD. Less liquid, watch spreads." },
  EURCAD: { displayName: "EUR/CAD", category: "forex", brokerSymbol: "EURCAD", baseCurrency: "EUR", quoteCurrency: "CAD", riskLevel: "Medium-High", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Cross pair with oil/EUR exposure. Wider spreads, trades well during London/NY overlap." },
  EURNZD: { displayName: "EUR/NZD", category: "forex", brokerSymbol: "EURNZD", baseCurrency: "EUR", quoteCurrency: "NZD", riskLevel: "High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.6, notes: "Very wide spread cross. Strong trending tendency. Use higher timeframes. Not recommended for scalping." },
  GBPJPY: { displayName: "GBP/JPY", category: "forex", brokerSymbol: "GBPJPY", baseCurrency: "GBP", quoteCurrency: "JPY", riskLevel: "High", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.8, notes: "The beast. Extremely volatile, wide ranges. Combines GBP volatility with JPY sensitivity. Not for beginners." },
  GBPCHF: { displayName: "GBP/CHF", category: "forex", brokerSymbol: "GBPCHF", baseCurrency: "GBP", quoteCurrency: "CHF", riskLevel: "High", tradingSessions: ["London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Volatile cross. Prone to SNB surprises. BoE policy vs SNB divergence key driver." },
  GBPAUD: { displayName: "GBP/AUD", category: "forex", brokerSymbol: "GBPAUD", baseCurrency: "GBP", quoteCurrency: "AUD", riskLevel: "High", tradingSessions: ["London", "Asia"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Volatile cross. GBP volatility combined with commodity AUD sensitivity." },
  GBPCAD: { displayName: "GBP/CAD", category: "forex", brokerSymbol: "GBPCAD", baseCurrency: "GBP", quoteCurrency: "CAD", riskLevel: "High", tradingSessions: ["London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Active during London/NY overlap. Oil prices affect CAD side." },
  GBPNZD: { displayName: "GBP/NZD", category: "forex", brokerSymbol: "GBPNZD", baseCurrency: "GBP", quoteCurrency: "NZD", riskLevel: "High", tradingSessions: ["London", "Asia"], recommendedTimeframes: ["H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.6, notes: "Very high volatility cross. Wide spreads. Trending pair — use higher timeframes." },
  AUDJPY: { displayName: "AUD/JPY", category: "forex", brokerSymbol: "AUDJPY", baseCurrency: "AUD", quoteCurrency: "JPY", riskLevel: "Medium-High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Risk barometer. Rises on risk-on, falls sharply on risk-off. Very active during Asia session." },
  AUDCHF: { displayName: "AUD/CHF", category: "forex", brokerSymbol: "AUDCHF", baseCurrency: "AUD", quoteCurrency: "CHF", riskLevel: "Medium-High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Risk/safe-haven cross. AUD is risk-on, CHF is safe-haven." },
  AUDCAD: { displayName: "AUD/CAD", category: "forex", brokerSymbol: "AUDCAD", baseCurrency: "AUD", quoteCurrency: "CAD", riskLevel: "Medium-High", tradingSessions: ["Asia", "London/NY Overlap"], recommendedTimeframes: ["H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Commodity cross. Both AUD and CAD track commodities. Driven by China and oil." },
  AUDNZD: { displayName: "AUD/NZD", category: "forex", brokerSymbol: "AUDNZD", baseCurrency: "AUD", quoteCurrency: "NZD", riskLevel: "Medium-High", tradingSessions: ["Asia"], recommendedTimeframes: ["H4", "D1"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Closely correlated pair. Slow-moving. RBA vs RBNZ policy divergence key driver." },
  NZDJPY: { displayName: "NZD/JPY", category: "forex", brokerSymbol: "NZDJPY", baseCurrency: "NZD", quoteCurrency: "JPY", riskLevel: "High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Risk-sensitive cross. Active during Asia. RBNZ vs BoJ divergence key." },
  NZDCHF: { displayName: "NZD/CHF", category: "forex", brokerSymbol: "NZDCHF", baseCurrency: "NZD", quoteCurrency: "CHF", riskLevel: "High", tradingSessions: ["Asia", "London"], recommendedTimeframes: ["H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Risk/safe-haven cross. Wider spreads, less liquid." },
  NZDCAD: { displayName: "NZD/CAD", category: "forex", brokerSymbol: "NZDCAD", baseCurrency: "NZD", quoteCurrency: "CAD", riskLevel: "High", tradingSessions: ["London/NY Overlap"], recommendedTimeframes: ["H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Commodity cross. Both economies export raw materials." },
  CADJPY: { displayName: "CAD/JPY", category: "forex", brokerSymbol: "CADJPY", baseCurrency: "CAD", quoteCurrency: "JPY", riskLevel: "Medium-High", tradingSessions: ["Asia", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Oil/JPY cross. CAD tracks crude oil. Active overlap period." },
  CADCHF: { displayName: "CAD/CHF", category: "forex", brokerSymbol: "CADCHF", baseCurrency: "CAD", quoteCurrency: "CHF", riskLevel: "High", tradingSessions: ["London"], recommendedTimeframes: ["H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Oil vs safe-haven cross. Less liquid, wider spreads." },
  CHFJPY: { displayName: "CHF/JPY", category: "forex", brokerSymbol: "CHFJPY", baseCurrency: "CHF", quoteCurrency: "JPY", riskLevel: "High", tradingSessions: ["London", "Asia"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Two safe-haven currencies. SNB vs BoJ divergence. Can trend strongly." },
  // ─── Global Indices ───────────────────────────────────────────────────────
  US30: { displayName: "Dow Jones (US30)", category: "indices", brokerSymbol: "US30", riskLevel: "Medium-High", tradingSessions: ["New York", "London/NY Overlap"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "30 large-cap US industrials. Fed-sensitive. Avoid during FOMC, NFP, CPI releases. Best during NY session." },
  NAS100: { displayName: "NASDAQ 100 (NAS100)", category: "indices", brokerSymbol: "NAS100", riskLevel: "High", tradingSessions: ["New York", "London/NY Overlap"], recommendedTimeframes: ["M15", "H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.8, notes: "Tech-heavy index. Rate-sensitive (long duration). Major tech earnings drive strong moves. High volatility." },
  SPX500: { displayName: "S&P 500 (SPX500)", category: "indices", brokerSymbol: "SPX500", riskLevel: "Medium-High", tradingSessions: ["New York", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Broadest US index. Balanced between value and growth. Fed policy and earnings breadth are key drivers." },
  GER40: { displayName: "DAX 40 (GER40)", category: "indices", brokerSymbol: "GER40", riskLevel: "High", tradingSessions: ["London", "London/NY Overlap"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "German blue chips. ECB-sensitive. China trade data impacts DAX exporters. Active during London session." },
  UK100: { displayName: "FTSE 100 (UK100)", category: "indices", brokerSymbol: "UK100", riskLevel: "Medium-High", tradingSessions: ["London"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "UK large caps. Heavy energy/mining exposure. Inversely correlated with GBP. BoE rate decisions key." },
  JP225: { displayName: "Nikkei 225 (JP225)", category: "indices", brokerSymbol: "JP225", riskLevel: "High", tradingSessions: ["Asia"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Japanese equities. Inversely correlated with JPY (weak JPY = bullish JP225). BoJ policy critical." },
  // ─── Stocks ───────────────────────────────────────────────────────────────
  AAPL: { displayName: "Apple Inc. (AAPL)", category: "stocks", brokerSymbol: "AAPL", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.7, notes: "World's largest company by market cap. iPhone cycle, Services revenue growth. Earnings 4x yearly." },
  MSFT: { displayName: "Microsoft Corp. (MSFT)", category: "stocks", brokerSymbol: "MSFT", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.7, notes: "Azure cloud growth and AI integration (OpenAI) key drivers. Defensive tech stock." },
  NVDA: { displayName: "NVIDIA Corp. (NVDA)", category: "stocks", brokerSymbol: "NVDA", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 72, defaultRiskPerTrade: 0.6, notes: "AI chip dominance. High volatility around earnings. Data center GPU demand drives price." },
  TSLA: { displayName: "Tesla Inc. (TSLA)", category: "stocks", brokerSymbol: "TSLA", riskLevel: "Very High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 75, defaultRiskPerTrade: 0.5, notes: "Extremely volatile. Delivery numbers, Elon Musk news, EV competition all drive sharp moves." },
  AMZN: { displayName: "Amazon.com (AMZN)", category: "stocks", brokerSymbol: "AMZN", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.7, notes: "AWS cloud + e-commerce. Ad revenue growth and AWS margin expansion key metrics." },
  META: { displayName: "Meta Platforms (META)", category: "stocks", brokerSymbol: "META", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 72, defaultRiskPerTrade: 0.6, notes: "Facebook/Instagram/WhatsApp advertising + AI Llama investments. Regulatory risk." },
  GOOGL: { displayName: "Alphabet Inc. (GOOGL)", category: "stocks", brokerSymbol: "GOOGL", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 72, defaultRiskPerTrade: 0.7, notes: "Search advertising + YouTube + Google Cloud. AI competition from OpenAI/MS a headwind." },
  AMD: { displayName: "AMD Inc. (AMD)", category: "stocks", brokerSymbol: "AMD", riskLevel: "Very High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 75, defaultRiskPerTrade: 0.5, notes: "AI GPU competitor to NVDA. High beta to semi sector. Strong trending stock." },
  NFLX: { displayName: "Netflix Inc. (NFLX)", category: "stocks", brokerSymbol: "NFLX", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 72, defaultRiskPerTrade: 0.6, notes: "Subscriber growth and ad-supported tier key metrics. Password sharing crackdown boosted numbers." },
  JPM: { displayName: "JPMorgan Chase (JPM)", category: "stocks", brokerSymbol: "JPM", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Largest US bank. Net interest margin tracks Fed rates. Reports earnings first among big banks." },
  BAC: { displayName: "Bank of America (BAC)", category: "stocks", brokerSymbol: "BAC", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Rate-sensitive bank. High beta to interest rates vs JPM." },
  XOM: { displayName: "Exxon Mobil (XOM)", category: "stocks", brokerSymbol: "XOM", riskLevel: "High", tradingSessions: ["New York"], recommendedTimeframes: ["H1", "H4", "D1"], minimumConfidence: 70, defaultRiskPerTrade: 0.7, notes: "Energy sector. Tracks crude oil price closely. Dividend-paying defensive name." },
  WMT: { displayName: "Walmart Inc. (WMT)", category: "stocks", brokerSymbol: "WMT", riskLevel: "Medium-High", tradingSessions: ["New York"], recommendedTimeframes: ["H4", "D1"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Defensive consumer staple. Benefits from consumer trade-down during economic stress." },
  COST: { displayName: "Costco Wholesale (COST)", category: "stocks", brokerSymbol: "COST", riskLevel: "Medium-High", tradingSessions: ["New York"], recommendedTimeframes: ["H4", "D1"], minimumConfidence: 68, defaultRiskPerTrade: 0.8, notes: "Membership-model retailer. Resilient in downturns. Monthly sales data tracked by traders." },
  // ─── Synthetic Volatility ─────────────────────────────────────────────────
  "Volatility 75 Index": { displayName: "Volatility 75 Index (V75)", category: "synthetic", brokerSymbol: "R_75", riskLevel: "High", tradingSessions: ["24/7"], recommendedTimeframes: ["M5", "M15", "H1"], minimumConfidence: 70, defaultRiskPerTrade: 1, notes: "Simulates 75% annualized volatility. Strong trending phases. Use EMA alignment and BOS strategies. Not news-driven — pure structure." },
  "Volatility 75 1s Index": { displayName: "V75 1s Index", category: "synthetic", brokerSymbol: "1HZ75V", riskLevel: "Very High", tradingSessions: ["24/7"], recommendedTimeframes: ["M1", "M5"], minimumConfidence: 80, defaultRiskPerTrade: 0.5, notes: "Extremely fast 1-second candles. Highest volatility of all synthetics. Requires very tight risk management and high confidence threshold. Experienced traders only." },
  "Volatility 25 1s Index": { displayName: "V25 1s Index", category: "synthetic", brokerSymbol: "1HZ25V", riskLevel: "Medium", tradingSessions: ["24/7"], recommendedTimeframes: ["M1", "M5", "M15"], minimumConfidence: 65, defaultRiskPerTrade: 1.5, notes: "Lower 25% volatility synthetic on 1-second candles. More predictable structure. Good for learning strategies." },
};

/** The registry consumers see: passport facts read through the passport. */
export const SYMBOL_REGISTRY: Record<string, SymbolInfo> = Object.fromEntries(
  Object.entries(AUTHORED_SYMBOL_REGISTRY).map(([key, info]) => [key, alignWithPassport(key, info)]),
);

export function getSymbolInfo(symbol: string): SymbolInfo | null {
  return SYMBOL_REGISTRY[symbol] ?? null;
}

export function getSymbolsByCategory(category: "forex" | "indices" | "stocks" | "synthetic"): Array<SymbolInfo & { symbol: string }> {
  return Object.entries(SYMBOL_REGISTRY)
    .filter(([, info]) => info.category === category)
    .map(([symbol, info]) => ({ symbol, ...info }));
}

export function getAllSymbols(): string[] {
  return Object.keys(SYMBOL_REGISTRY);
}
