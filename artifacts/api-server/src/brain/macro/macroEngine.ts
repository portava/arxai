// Macro Engine — market-type-specific macro analysis

export type ForexMacroAnalysis = {
  type: "forex";
  baseCurrencyStrength: number;
  quoteCurrencyStrength: number;
  interestRateBias: "Hawkish" | "Dovish" | "Neutral";
  inflationBias: "High" | "Moderate" | "Low";
  jobsBias: "Strong" | "Moderate" | "Weak";
  GDPBias: "Expanding" | "Stable" | "Contracting";
  riskSentimentBias: "Risk-On" | "Risk-Off" | "Neutral";
  macroBias: "Bullish" | "Bearish" | "Neutral";
  macroScore: number;
  notes: string[];
};

export type IndicesMacroAnalysis = {
  type: "indices";
  dollarBias: "Strong" | "Weak" | "Neutral";
  bondYieldBias: "Rising" | "Falling" | "Stable";
  fedBias: "Hawkish" | "Dovish" | "Neutral";
  inflationRisk: "High" | "Moderate" | "Low";
  earningsSentiment: "Positive" | "Negative" | "Neutral";
  riskSentiment: "Risk-On" | "Risk-Off" | "Neutral";
  macroBias: "Bullish" | "Bearish" | "Neutral";
  macroScore: number;
  notes: string[];
};

export type StocksMacroAnalysis = {
  type: "stocks";
  sectorBias: "Bullish" | "Bearish" | "Neutral";
  earningsRisk: "High" | "Medium" | "Low";
  newsSentiment: "Positive" | "Negative" | "Neutral";
  relativeStrength: number;
  macroBias: "Bullish" | "Bearish" | "Neutral";
  macroScore: number;
  notes: string[];
};

export type SyntheticMacroAnalysis = {
  type: "synthetic";
  macroBias: "Not news-driven";
  macroScore: number;
  notes: string[];
};

export type MacroAnalysis = ForexMacroAnalysis | IndicesMacroAnalysis | StocksMacroAnalysis | SyntheticMacroAnalysis;

// ─── Currency macro data ──────────────────────────────────────────────────────

const CURRENCY_MACRO: Record<string, { strength: number; rateBias: "Hawkish" | "Dovish" | "Neutral"; inflation: "High" | "Moderate" | "Low"; jobs: "Strong" | "Moderate" | "Weak"; gdp: "Expanding" | "Stable" | "Contracting" }> = {
  USD: { strength: 72, rateBias: "Hawkish", inflation: "Moderate", jobs: "Strong", gdp: "Expanding" },
  EUR: { strength: 38, rateBias: "Dovish", inflation: "Moderate", jobs: "Moderate", gdp: "Contracting" },
  GBP: { strength: 55, rateBias: "Neutral", inflation: "High", jobs: "Moderate", gdp: "Stable" },
  JPY: { strength: 30, rateBias: "Dovish", inflation: "Low", jobs: "Moderate", gdp: "Stable" },
  CHF: { strength: 52, rateBias: "Dovish", inflation: "Low", jobs: "Strong", gdp: "Stable" },
  AUD: { strength: 48, rateBias: "Neutral", inflation: "Moderate", jobs: "Moderate", gdp: "Stable" },
  NZD: { strength: 42, rateBias: "Dovish", inflation: "Moderate", jobs: "Moderate", gdp: "Contracting" },
  CAD: { strength: 47, rateBias: "Dovish", inflation: "Low", jobs: "Moderate", gdp: "Stable" },
};

// ─── Sector macro data ────────────────────────────────────────────────────────

const SECTOR_MACRO: Record<string, { bias: "Bullish" | "Bearish" | "Neutral"; earningsRisk: "High" | "Medium" | "Low"; sentiment: "Positive" | "Negative" | "Neutral"; relativeStrength: number }> = {
  Technology: { bias: "Bullish", earningsRisk: "Medium", sentiment: "Positive", relativeStrength: 72 },
  Semiconductors: { bias: "Bullish", earningsRisk: "High", sentiment: "Positive", relativeStrength: 80 },
  "EV / Auto": { bias: "Neutral", earningsRisk: "High", sentiment: "Negative", relativeStrength: 38 },
  "E-commerce / Cloud": { bias: "Bullish", earningsRisk: "Medium", sentiment: "Positive", relativeStrength: 68 },
  "Social Media / AI": { bias: "Bullish", earningsRisk: "Medium", sentiment: "Positive", relativeStrength: 70 },
  Banking: { bias: "Neutral", earningsRisk: "Medium", sentiment: "Neutral", relativeStrength: 52 },
  Energy: { bias: "Neutral", earningsRisk: "Medium", sentiment: "Neutral", relativeStrength: 50 },
  "Consumer Staples": { bias: "Neutral", earningsRisk: "Low", sentiment: "Neutral", relativeStrength: 48 },
  Streaming: { bias: "Neutral", earningsRisk: "High", sentiment: "Neutral", relativeStrength: 55 },
  "E-commerce / China": { bias: "Bearish", earningsRisk: "High", sentiment: "Negative", relativeStrength: 32 },
};

const STOCK_SECTOR: Record<string, string> = {
  AAPL: "Technology", MSFT: "Technology", NVDA: "Semiconductors", TSLA: "EV / Auto",
  AMZN: "E-commerce / Cloud", META: "Social Media / AI", GOOGL: "Technology", AMD: "Semiconductors",
  NFLX: "Streaming", JPM: "Banking", BAC: "Banking", XOM: "Energy", WMT: "Consumer Staples", COST: "Consumer Staples",
};

// ─── Global macro context (mock) ──────────────────────────────────────────────

function getGlobalMacro() {
  const bondYield10Y = 4.45;
  const bondYieldBias: "Rising" | "Falling" | "Stable" = bondYield10Y > 4.5 ? "Rising" : bondYield10Y < 4.2 ? "Falling" : "Stable";
  const vixEstimate = 15.2;
  const riskSentiment: "Risk-On" | "Risk-Off" | "Neutral" = vixEstimate < 16 ? "Risk-On" : vixEstimate > 25 ? "Risk-Off" : "Neutral";
  return { bondYield10Y, bondYieldBias, riskSentiment, fedBias: "Neutral" as const, dollarStrength: "Strong" as const };
}

// ─── Forex macro ──────────────────────────────────────────────────────────────

function parseCurrencies(symbol: string): { base: string; quote: string } {
  const knownBases = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"];
  for (const b of knownBases) {
    if (symbol.startsWith(b)) {
      const quote = symbol.slice(b.length);
      if (CURRENCY_MACRO[quote]) return { base: b, quote };
    }
  }
  return { base: symbol.slice(0, 3).toUpperCase(), quote: symbol.slice(3, 6).toUpperCase() };
}

export function analyzeMacro(symbol: string, category: "forex" | "indices" | "stocks" | "synthetic"): MacroAnalysis {
  if (category === "synthetic") {
    return {
      type: "synthetic",
      macroBias: "Not news-driven",
      macroScore: 50,
      notes: ["Synthetic volatility indices are not affected by economic news or macro events.", "They run 24/7 on simulated volatility — pure price structure and technical analysis drives signals.", "No macro filter applied — rely entirely on technical engine output."],
    };
  }

  if (category === "forex") {
    const { base, quote } = parseCurrencies(symbol);
    const baseMacro = CURRENCY_MACRO[base] ?? { strength: 50, rateBias: "Neutral", inflation: "Moderate", jobs: "Moderate", gdp: "Stable" };
    const quoteMacro = CURRENCY_MACRO[quote] ?? { strength: 50, rateBias: "Neutral", inflation: "Moderate", jobs: "Moderate", gdp: "Stable" };
    const global = getGlobalMacro();
    const notes: string[] = [];

    let baseAdj = baseMacro.strength;
    let quoteAdj = quoteMacro.strength;
    // Risk sentiment adjustments
    if (global.riskSentiment === "Risk-On") {
      if (["AUD", "NZD", "CAD"].includes(base)) baseAdj += 5;
      if (["JPY", "CHF"].includes(base)) baseAdj -= 3;
      if (["AUD", "NZD", "CAD"].includes(quote)) quoteAdj += 5;
      if (["JPY", "CHF"].includes(quote)) quoteAdj -= 3;
    } else if (global.riskSentiment === "Risk-Off") {
      if (["USD", "CHF", "JPY"].includes(base)) baseAdj += 5;
      if (["AUD", "NZD"].includes(base)) baseAdj -= 5;
      if (["USD", "CHF", "JPY"].includes(quote)) quoteAdj += 5;
      if (["AUD", "NZD"].includes(quote)) quoteAdj -= 5;
    }
    baseAdj = Math.max(0, Math.min(100, Math.round(baseAdj)));
    quoteAdj = Math.max(0, Math.min(100, Math.round(quoteAdj)));

    const diff = baseAdj - quoteAdj;
    const macroBias: "Bullish" | "Bearish" | "Neutral" = diff > 12 ? "Bullish" : diff < -12 ? "Bearish" : "Neutral";
    const macroScore = Math.max(20, Math.min(90, 50 + diff * 0.7));

    if (baseMacro.rateBias === "Hawkish") notes.push(`${base} is Hawkish — central bank tightening bias supports ${base}`);
    if (quoteMacro.rateBias === "Dovish") notes.push(`${quote} is Dovish — cutting rates, weakens ${quote}`);
    if (global.riskSentiment !== "Neutral") notes.push(`Risk sentiment is ${global.riskSentiment} — impacts risk-correlated currencies`);
    notes.push(`${base} strength: ${baseAdj}/100 | ${quote} strength: ${quoteAdj}/100`);

    const interestRateBias: "Hawkish" | "Dovish" | "Neutral" = baseMacro.rateBias === "Hawkish" && quoteMacro.rateBias !== "Hawkish" ? "Hawkish" : baseMacro.rateBias === "Dovish" && quoteMacro.rateBias !== "Dovish" ? "Dovish" : "Neutral";

    return { type: "forex", baseCurrencyStrength: baseAdj, quoteCurrencyStrength: quoteAdj, interestRateBias, inflationBias: baseMacro.inflation, jobsBias: baseMacro.jobs, GDPBias: baseMacro.gdp, riskSentimentBias: global.riskSentiment, macroBias, macroScore: Math.round(macroScore), notes };
  }

  if (category === "indices") {
    const global = getGlobalMacro();
    const notes: string[] = [];
    let bullScore = 0;
    let bearScore = 0;
    const INDICES_BIAS: Record<string, { dollarImpact: number; rateImpact: number }> = {
      US30:   { dollarImpact: -1, rateImpact: -1 },
      NAS100: { dollarImpact: -1, rateImpact: -2 },
      SPX500: { dollarImpact: -1, rateImpact: -1 },
      GER40:  { dollarImpact: 1, rateImpact: -1 },
      UK100:  { dollarImpact: 1, rateImpact: -0.5 },
      JP225:  { dollarImpact: 2, rateImpact: 0.5 },
    };
    const bias = INDICES_BIAS[symbol] ?? { dollarImpact: 0, rateImpact: 0 };
    if (global.dollarStrength === "Strong" && bias.dollarImpact < 0) { bearScore += 10; notes.push(`Strong USD is a headwind for ${symbol}`); }
    else if (global.dollarStrength === "Strong" && bias.dollarImpact > 0) { bullScore += 10; notes.push(`Strong USD is a tailwind for ${symbol} (weak local currency boosts exporters)`); }
    if (global.bondYieldBias === "Rising" && bias.rateImpact < 0) { bearScore += 15; notes.push("Rising bond yields compress equity valuations"); }
    else if (global.bondYieldBias === "Falling" && bias.rateImpact < 0) { bullScore += 10; notes.push("Falling yields are a tailwind for equities"); }
    if (global.riskSentiment === "Risk-On") { bullScore += 15; notes.push("Risk-On sentiment — equity inflows increasing"); }
    else if (global.riskSentiment === "Risk-Off") { bearScore += 15; notes.push("Risk-Off sentiment — flight to safety, equity outflows"); }

    const net = bullScore - bearScore;
    const macroBias: "Bullish" | "Bearish" | "Neutral" = net >= 15 ? "Bullish" : net <= -15 ? "Bearish" : "Neutral";
    const macroScore = Math.max(20, Math.min(85, 50 + net * 0.7));

    return { type: "indices", dollarBias: global.dollarStrength === "Strong" ? "Strong" : "Neutral", bondYieldBias: global.bondYieldBias, fedBias: global.fedBias, inflationRisk: "Moderate", earningsSentiment: global.riskSentiment === "Risk-On" ? "Positive" : "Neutral", riskSentiment: global.riskSentiment, macroBias, macroScore: Math.round(macroScore), notes };
  }

  if (category === "stocks") {
    const sector = STOCK_SECTOR[symbol] ?? "Technology";
    const sectorData = SECTOR_MACRO[sector] ?? { bias: "Neutral", earningsRisk: "Medium", sentiment: "Neutral", relativeStrength: 50 };
    const global = getGlobalMacro();
    const notes: string[] = [];
    let macroScore = 50;
    if (sectorData.bias === "Bullish") { macroScore += 15; notes.push(`${sector} sector has bullish macro tailwinds`); }
    else if (sectorData.bias === "Bearish") { macroScore -= 15; notes.push(`${sector} sector faces macro headwinds`); }
    if (global.riskSentiment === "Risk-On") { macroScore += 5; notes.push("Risk-On environment supports equity markets"); }
    else if (global.riskSentiment === "Risk-Off") { macroScore -= 10; notes.push("Risk-Off sentiment — reduce equity exposure"); }
    if (global.bondYieldBias === "Rising") { macroScore -= 8; notes.push("Rising yields are a headwind for growth stocks"); }
    notes.push(`Sector: ${sector} | Relative strength: ${sectorData.relativeStrength}/100`);
    const macroBias: "Bullish" | "Bearish" | "Neutral" = macroScore >= 60 ? "Bullish" : macroScore <= 40 ? "Bearish" : "Neutral";
    return { type: "stocks", sectorBias: sectorData.bias, earningsRisk: sectorData.earningsRisk, newsSentiment: sectorData.sentiment, relativeStrength: sectorData.relativeStrength, macroBias, macroScore: Math.max(20, Math.min(85, Math.round(macroScore))), notes };
  }

  return { type: "synthetic", macroBias: "Not news-driven", macroScore: 50, notes: ["Unknown category — defaulting to neutral macro analysis."] };
}
