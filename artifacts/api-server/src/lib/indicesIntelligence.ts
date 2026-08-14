// Indices Intelligence Module — macro analysis for global equity indices
import { detectSession } from "./strategyEngine.js";

export interface IndexIntelligence {
  symbol: string;
  name: string;
  region: string;
  currentLevel: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;
  fedSentiment: "Hawkish" | "Neutral" | "Dovish";
  dollarImpact: "Positive" | "Negative" | "Neutral";
  bondYieldBias: "Rising" | "Falling" | "Stable";
  vixState: "Low" | "Moderate" | "High" | "Extreme";
  riskSentiment: "Risk-On" | "Risk-Off" | "Neutral";
  marketCondition: string;
  keyDrivers: string[];
  riskFactors: string[];
}

export interface IndicesIntelligenceResult {
  session: string;
  dollarStrength: "Weak" | "Moderate" | "Strong";
  riskSentiment: "Risk-On" | "Risk-Off" | "Neutral";
  fedExpectation: "Hawkish" | "Neutral" | "Dovish";
  bondYield10Y: number;
  vixEstimate: number;
  indices: IndexIntelligence[];
  marketSummary: string;
}

// Mock macro context
function getMacroContext() {
  const hour = new Date().getUTCHours();
  // VIX simulation
  const vixBase = 14 + Math.random() * 8;
  const vixState: "Low" | "Moderate" | "High" | "Extreme" =
    vixBase < 15 ? "Low" : vixBase < 20 ? "Moderate" : vixBase < 30 ? "High" : "Extreme";
  // Risk sentiment
  const riskSentiment: "Risk-On" | "Risk-Off" | "Neutral" =
    vixBase < 16 ? "Risk-On" : vixBase > 25 ? "Risk-Off" : "Neutral";
  // Dollar strength (inverse relationship with most indices except JP225)
  const dollarStrength: "Weak" | "Moderate" | "Strong" = "Strong"; // Mock: USD strong
  // Bond yields
  const bondYield10Y = 4.45 + (Math.random() - 0.5) * 0.3;
  const bondYieldBias: "Rising" | "Falling" | "Stable" = bondYield10Y > 4.5 ? "Rising" : bondYield10Y < 4.3 ? "Falling" : "Stable";
  // Fed expectation
  const fedExpectation = "Neutral" as "Hawkish" | "Neutral" | "Dovish"; // Mock: data-dependent

  return { vixBase, vixState, riskSentiment, dollarStrength, bondYield10Y, bondYieldBias, fedExpectation, hour };
}

function getIndexBias(
  symbol: string,
  macro: ReturnType<typeof getMacroContext>
): { bias: "Bullish" | "Bearish" | "Neutral"; confidence: number; condition: string; drivers: string[]; risks: string[] } {
  const { vixState, riskSentiment, dollarStrength, bondYieldBias, fedExpectation } = macro;
  let bullPoints = 0;
  let bearPoints = 0;

  if (riskSentiment === "Risk-On") bullPoints += 2;
  if (riskSentiment === "Risk-Off") bearPoints += 2;
  if (bondYieldBias === "Rising") bearPoints += 1; // Higher yields = headwind for equities
  if (bondYieldBias === "Falling") bullPoints += 1;

  const drivers: string[] = [];
  const risks: string[] = [];

  switch (symbol) {
    case "US30":
      if (dollarStrength === "Strong") bearPoints += 1;
      if (fedExpectation === "Hawkish") bearPoints += 1;
      if (fedExpectation === "Dovish") bullPoints += 2;
      drivers.push("Fed policy expectations", "Industrial sector earnings", "Bond yields");
      risks.push("Inflation surprise", "Fed rate hike", "Jobs data miss");
      break;
    case "NAS100":
      // Tech more sensitive to rates (long duration)
      if (bondYieldBias === "Rising") bearPoints += 2;
      if (riskSentiment === "Risk-On") bullPoints += 2;
      drivers.push("Tech earnings (NVDA, AAPL, MSFT)", "AI sector momentum", "Rate expectations");
      risks.push("Rate spike", "Tech earnings miss", "Rotation to value");
      break;
    case "SPX500":
      // Broad market — balanced
      if (riskSentiment === "Risk-On") bullPoints += 1;
      drivers.push("Earnings breadth", "Economic data", "Fed pivot expectations");
      risks.push("Earnings recession", "Credit stress", "Geopolitical risk");
      break;
    case "GER40":
      if (dollarStrength === "Strong") bearPoints += 1; // EUR weakness hurts imports
      drivers.push("ECB policy", "German industrial output", "China trade data");
      risks.push("Energy price spike", "ECB policy error", "German recession deepening");
      break;
    case "UK100":
      drivers.push("BoE rates", "FTSE energy/mining sector", "GBP movements");
      risks.push("BoE hawkish surprise", "UK political risk", "Global risk-off");
      break;
    case "JP225":
      // Weak JPY = positive for JP225 exporters
      if (dollarStrength === "Strong") bullPoints += 2; // USD/JPY high = JPY weak = JP225 bullish
      drivers.push("USD/JPY (weak JPY lifts exporters)", "BoJ policy", "US growth spillover");
      risks.push("BoJ rate hike surprise", "JPY intervention", "China slowdown");
      break;
  }

  const net = bullPoints - bearPoints;
  const bias: "Bullish" | "Bearish" | "Neutral" = net >= 2 ? "Bullish" : net <= -2 ? "Bearish" : "Neutral";
  const confidence = Math.min(85, 50 + Math.abs(net) * 8 + (Math.random() * 10));
  const condition = vixState === "High" || vixState === "Extreme" ? "High Volatility" :
    riskSentiment === "Risk-On" ? "Risk-On Rally" :
    riskSentiment === "Risk-Off" ? "Risk-Off Selloff" : "Consolidation";

  return { bias, confidence: Math.round(confidence), condition, drivers, risks };
}

const INDEX_META: Record<string, { name: string; region: string; level: number }> = {
  "US30":   { name: "Dow Jones Industrial Average", region: "USA", level: 39200 },
  "NAS100": { name: "NASDAQ 100", region: "USA", level: 18150 },
  "SPX500": { name: "S&P 500", region: "USA", level: 5230 },
  "GER40":  { name: "DAX 40", region: "Germany", level: 18400 },
  "UK100":  { name: "FTSE 100", region: "UK", level: 8280 },
  "JP225":  { name: "Nikkei 225", region: "Japan", level: 38900 },
};

export function getIndicesIntelligence(): IndicesIntelligenceResult {
  const session = detectSession();
  const macro = getMacroContext();

  const indices: IndexIntelligence[] = Object.entries(INDEX_META).map(([symbol, meta]) => {
    const { bias, confidence, condition, drivers, risks } = getIndexBias(symbol, macro);
    return {
      symbol,
      name: meta.name,
      region: meta.region,
      currentLevel: meta.level + (Math.random() - 0.5) * meta.level * 0.002,
      bias,
      confidence,
      fedSentiment: macro.fedExpectation,
      dollarImpact: macro.dollarStrength === "Strong" ? "Negative" : macro.dollarStrength === "Weak" ? "Positive" : "Neutral",
      bondYieldBias: macro.bondYieldBias,
      vixState: macro.vixState,
      riskSentiment: macro.riskSentiment,
      marketCondition: condition,
      keyDrivers: drivers,
      riskFactors: risks,
    };
  });

  const bullCount = indices.filter((i) => i.bias === "Bullish").length;
  const bearCount = indices.filter((i) => i.bias === "Bearish").length;
  const marketSummary = bullCount >= 4
    ? "Global equities broadly bullish. Risk-on conditions prevailing. Proceed with trend-following setups."
    : bearCount >= 4
    ? "Global equities under pressure. Risk-off conditions. Reduce exposure and favour defensive plays."
    : `Mixed signals across global indices. ${bullCount} bullish, ${bearCount} bearish. Wait for clarity.`;

  return {
    session,
    dollarStrength: macro.dollarStrength,
    riskSentiment: macro.riskSentiment,
    fedExpectation: macro.fedExpectation,
    bondYield10Y: Math.round(macro.bondYield10Y * 100) / 100,
    vixEstimate: Math.round(macro.vixBase * 10) / 10,
    indices,
    marketSummary,
  };
}

export function getSyntheticAnalysis(): object {
  const symbols = [
    { symbol: "Volatility 75 Index", name: "V75", volatilityLevel: "High", trend: "Sideways", atr: 64.2, atrState: "Normal", riskLevel: "High", recommendedLotSize: "0.01", notes: "V75 exhibits strong trending phases. Use EMA alignment and BOS. Avoid during extreme ATR spikes." },
    { symbol: "Volatility 75 1s Index", name: "V75 1s", volatilityLevel: "Extreme", trend: "Noisy", atr: 82.5, atrState: "Expanding", riskLevel: "Very High", recommendedLotSize: "0.01", notes: "Extremely fast-moving. 1-second candles require tight risk management. Strict confidence threshold required. For experienced traders only." },
    { symbol: "Volatility 25 1s Index", name: "V25 1s", volatilityLevel: "Medium", trend: "Uptrend", atr: 4.8, atrState: "Contracting", riskLevel: "Medium", recommendedLotSize: "0.05", notes: "Lower volatility synthetic. Suitable for strategy testing. More predictable structure than V75. Good for learning." },
  ];
  return { symbols };
}
