import type { InsertSymbol } from "../schema/symbols";

const FX_MAJORS = ["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD"];
const FX_MINORS = [
  "EURGBP","EURJPY","EURCHF","EURAUD","EURCAD","EURNZD",
  "GBPJPY","GBPCHF","GBPAUD","GBPCAD","GBPNZD",
  "AUDJPY","AUDCHF","AUDCAD","AUDNZD",
  "NZDJPY","NZDCHF","NZDCAD",
  "CADJPY","CADCHF","CHFJPY",
];
const INDICES = ["US30","NAS100","SPX500","GER40","UK100","JP225"];
const STOCKS  = ["AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","NFLX","JPM","BAC","XOM","WMT","COST"];
const SYNTHETIC = [
  { symbol: "Volatility 75 Index",      display: "Volatility 75 Index",     riskLevel: "HIGH",    minConf: 75, riskPct: 0.5 },
  { symbol: "Volatility 75 (1s) Index", display: "Volatility 75 1s Index",  riskLevel: "EXTREME", minConf: 85, riskPct: 0.25 },
  { symbol: "Volatility 25 (1s) Index", display: "Volatility 25 1s Index",  riskLevel: "HIGH",    minConf: 80, riskPct: 0.4 },
];
const CRYPTO = ["BTCUSD","ETHUSD"]; // placeholders per spec

const fxDisplay = (s: string) => `${s.slice(0, 3)} / ${s.slice(3)}`;

export function buildSymbolSeeds(): InsertSymbol[] {
  const rows: InsertSymbol[] = [];

  for (const s of FX_MAJORS) rows.push({
    symbol: s, displayName: fxDisplay(s), marketType: "forex", brokerSymbol: s,
    riskLevel: "MEDIUM", recommendedTimeframes: ["M5","M15","H1","H4"],
    tradingSessions: ["LONDON","NEW_YORK","OVERLAP"],
    minimumConfidence: 70, defaultRiskPerTrade: 0.5, notes: "Major pair — deepest liquidity.",
  });

  for (const s of FX_MINORS) rows.push({
    symbol: s, displayName: fxDisplay(s), marketType: "forex", brokerSymbol: s,
    riskLevel: "MEDIUM", recommendedTimeframes: ["M15","H1","H4"],
    tradingSessions: ["LONDON","NEW_YORK"],
    minimumConfidence: 72, defaultRiskPerTrade: 0.4, notes: "Cross pair — wider spreads than majors.",
  });

  for (const s of INDICES) rows.push({
    symbol: s, displayName: s, marketType: "indices", brokerSymbol: s,
    riskLevel: "MEDIUM", recommendedTimeframes: ["M5","M15","H1"],
    tradingSessions: s === "JP225" ? ["ASIA"] : s === "GER40" || s === "UK100" ? ["LONDON"] : ["NEW_YORK"],
    minimumConfidence: 72, defaultRiskPerTrade: 0.5,
    notes: s === "US30" ? "Blocks on major U.S. news." : "",
  });

  for (const s of STOCKS) rows.push({
    symbol: s, displayName: s, marketType: "stocks", brokerSymbol: s,
    riskLevel: "MEDIUM", recommendedTimeframes: ["M15","H1","H4"],
    tradingSessions: ["NEW_YORK"],
    minimumConfidence: 72, defaultRiskPerTrade: 0.5,
    notes: "Blocks around earnings unless overridden.",
  });

  for (const s of SYNTHETIC) rows.push({
    symbol: s.symbol, displayName: s.display, marketType: "synthetic", brokerSymbol: s.symbol,
    riskLevel: s.riskLevel, recommendedTimeframes: ["M1","M5","M15"],
    tradingSessions: ["24/7"],
    minimumConfidence: s.minConf, defaultRiskPerTrade: s.riskPct,
    notes: "Synthetic — ignores real-world news; ATR + structure focus.",
  });

  for (const s of CRYPTO) rows.push({
    symbol: s, displayName: `${s.slice(0,3)} / ${s.slice(3)}`, marketType: "crypto", brokerSymbol: s,
    riskLevel: "HIGH", recommendedTimeframes: ["M15","H1","H4"],
    tradingSessions: ["24/7"],
    minimumConfidence: 78, defaultRiskPerTrade: 0.4, notes: "Placeholder — provider not yet wired.",
  });

  return rows;
}
