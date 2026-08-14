// Forex Intelligence Module — macro scoring, currency strength, session analysis
import { detectSession } from "./strategyEngine.js";

export interface CurrencyData {
  currency: string;
  strength: number; // 0–100
  bias: "Bullish" | "Bearish" | "Neutral";
  centralBank: string;
  rateExpectation: "Hawkish" | "Neutral" | "Dovish";
  inflationPressure: "High" | "Moderate" | "Low";
  notes: string;
}

export interface ForexPairIntelligence {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  baseStrength: number;
  quoteStrength: number;
  rateDifferential: string;
  macroBias: "Bullish" | "Bearish" | "Neutral";
  technicalBias: "Bullish" | "Bearish" | "Neutral";
  combinedBias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;
  riskNote: string;
}

export interface ForexIntelligenceResult {
  session: string;
  riskSentiment: "Risk-On" | "Risk-Off" | "Neutral";
  currencies: CurrencyData[];
  pairs: ForexPairIntelligence[];
  sessionNotes: string;
}

// Mock macro data (updated periodically in production via central bank feeds)
const CURRENCY_MACRO: Record<string, Omit<CurrencyData, "strength">> = {
  USD: { currency: "USD", bias: "Bullish", centralBank: "Federal Reserve", rateExpectation: "Hawkish", inflationPressure: "Moderate", notes: "Strong jobs data, Fed holding rates high. Dollar well-bid." },
  EUR: { currency: "EUR", bias: "Bearish", centralBank: "ECB", rateExpectation: "Dovish", inflationPressure: "Moderate", notes: "ECB cutting rates, weak German growth drag on Euro." },
  GBP: { currency: "GBP", bias: "Neutral", centralBank: "Bank of England", rateExpectation: "Neutral", inflationPressure: "High", notes: "BoE cautious, sticky services inflation keeping rates elevated." },
  JPY: { currency: "JPY", bias: "Bearish", centralBank: "Bank of Japan", rateExpectation: "Dovish", inflationPressure: "Low", notes: "BoJ ultra-loose, JPY under pressure vs USD. Watch BoJ intervention risk." },
  CHF: { currency: "CHF", bias: "Neutral", centralBank: "Swiss National Bank", rateExpectation: "Dovish", inflationPressure: "Low", notes: "SNB cutting rates. CHF safe-haven demand on risk-off events." },
  AUD: { currency: "AUD", bias: "Neutral", centralBank: "Reserve Bank of Australia", rateExpectation: "Neutral", inflationPressure: "Moderate", notes: "RBA holding, commodity prices mixed. AUD sensitive to China data." },
  NZD: { currency: "NZD", bias: "Bearish", centralBank: "Reserve Bank of NZ", rateExpectation: "Dovish", inflationPressure: "Moderate", notes: "RBNZ shifting dovish, weaker dairy prices weigh on NZD." },
  CAD: { currency: "CAD", bias: "Neutral", centralBank: "Bank of Canada", rateExpectation: "Dovish", inflationPressure: "Low", notes: "BoC cutting, oil prices uncertain. CAD tracks crude oil and USD." },
};

// Base strength scores from macro fundamentals (updated with slight randomization for demo)
const BASE_STRENGTH: Record<string, number> = {
  USD: 72, EUR: 38, GBP: 55, JPY: 30, CHF: 52, AUD: 50, NZD: 42, CAD: 48,
};

function computeStrength(currency: string, riskSentiment: "Risk-On" | "Risk-Off" | "Neutral"): number {
  let base = BASE_STRENGTH[currency] ?? 50;
  // Risk sentiment adjustments
  if (riskSentiment === "Risk-Off") {
    if (currency === "USD" || currency === "CHF" || currency === "JPY") base += 5;
    if (currency === "AUD" || currency === "NZD") base -= 5;
  } else if (riskSentiment === "Risk-On") {
    if (currency === "AUD" || currency === "NZD" || currency === "CAD") base += 5;
    if (currency === "JPY" || currency === "CHF") base -= 3;
  }
  // Small demo randomization (±3 points)
  base += (Math.random() - 0.5) * 6;
  return Math.max(0, Math.min(100, Math.round(base)));
}

function getRiskSentiment(): "Risk-On" | "Risk-Off" | "Neutral" {
  const hour = new Date().getUTCHours();
  // Simulate sentiment based on session
  if (hour >= 8 && hour < 13) return "Neutral"; // London — wait and see
  if (hour >= 13 && hour < 17) return Math.random() > 0.5 ? "Risk-On" : "Neutral"; // NY — varies
  if (hour >= 0 && hour < 8) return "Risk-Off"; // Asia — risk-off bias
  return "Neutral";
}

function getMacroBias(base: string, quote: string, strengths: Record<string, number>): "Bullish" | "Bearish" | "Neutral" {
  const diff = (strengths[base] ?? 50) - (strengths[quote] ?? 50);
  if (diff > 12) return "Bullish";
  if (diff < -12) return "Bearish";
  return "Neutral";
}

const PAIRS: Array<{ symbol: string; base: string; quote: string }> = [
  { symbol: "EURUSD", base: "EUR", quote: "USD" },
  { symbol: "GBPUSD", base: "GBP", quote: "USD" },
  { symbol: "USDJPY", base: "USD", quote: "JPY" },
  { symbol: "USDCHF", base: "USD", quote: "CHF" },
  { symbol: "USDCAD", base: "USD", quote: "CAD" },
  { symbol: "AUDUSD", base: "AUD", quote: "USD" },
  { symbol: "NZDUSD", base: "NZD", quote: "USD" },
  { symbol: "EURJPY", base: "EUR", quote: "JPY" },
  { symbol: "GBPJPY", base: "GBP", quote: "JPY" },
  { symbol: "EURGBP", base: "EUR", quote: "GBP" },
  { symbol: "AUDJPY", base: "AUD", quote: "JPY" },
  { symbol: "CADJPY", base: "CAD", quote: "JPY" },
];

const SESSION_NOTES: Record<string, string> = {
  "Asia": "Asia session active. JPY, AUD, NZD pairs most liquid. Watch Tokyo fix (04:55 UTC) for JPY moves.",
  "London": "London session open. EUR, GBP pairs peak liquidity. Highest forex volume window of the day.",
  "London/NY Overlap": "London/NY overlap — peak global liquidity. All major pairs active. Highest volatility window.",
  "New York": "New York session active. USD pairs dominant. Watch US economic releases at 12:30-14:00 UTC.",
  "Closed": "Interbank market thin. Low liquidity, wider spreads. Avoid new positions.",
};

export function getForexIntelligence(): ForexIntelligenceResult {
  const session = detectSession();
  const riskSentiment = getRiskSentiment();
  const strengths: Record<string, number> = {};
  const currencies: CurrencyData[] = [];

  for (const [currency, macro] of Object.entries(CURRENCY_MACRO)) {
    const strength = computeStrength(currency, riskSentiment);
    strengths[currency] = strength;
    currencies.push({ ...macro, strength });
  }

  // Sort by strength desc
  currencies.sort((a, b) => b.strength - a.strength);

  const pairs: ForexPairIntelligence[] = PAIRS.map(({ symbol, base, quote }) => {
    const baseStrength = strengths[base] ?? 50;
    const quoteStrength = strengths[quote] ?? 50;
    const diff = baseStrength - quoteStrength;
    const macroBias = getMacroBias(base, quote, strengths);
    // Mock technical bias based on base macro
    const macroObj = CURRENCY_MACRO[base];
    const technicalBias: "Bullish" | "Bearish" | "Neutral" = macroObj?.bias ?? "Neutral";
    const combinedBias: "Bullish" | "Bearish" | "Neutral" =
      macroBias === technicalBias ? macroBias :
      (macroBias !== "Neutral" ? macroBias : technicalBias);
    const confidence = Math.min(90, 50 + Math.abs(diff));
    const baseMacro = CURRENCY_MACRO[base];
    const quoteMacro = CURRENCY_MACRO[quote];
    const rateDifferential = `${base} ${baseMacro?.rateExpectation ?? "Neutral"} vs ${quote} ${quoteMacro?.rateExpectation ?? "Neutral"}`;
    return { symbol, baseCurrency: base, quoteCurrency: quote, baseStrength, quoteStrength, rateDifferential, macroBias, technicalBias, combinedBias, confidence, riskNote: macroObj?.notes ?? "" };
  });

  return { session, riskSentiment, currencies, pairs, sessionNotes: SESSION_NOTES[session] ?? "" };
}
