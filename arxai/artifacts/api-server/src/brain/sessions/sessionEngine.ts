// Session Engine — detects trading session and scores liquidity/market suitability

export interface SessionAnalysis {
  session: "Asia" | "London" | "New York" | "London/NY Overlap" | "Off-hours";
  utcHour: number;
  liquidityLevel: "Low" | "Medium" | "High" | "Very High";
  recommendedMarkets: string[];
  caution: string;
  sessionScore: number;
}

const SESSION_MARKETS: Record<string, { best: string[]; caution: string; score: number; liquidity: "Low" | "Medium" | "High" | "Very High" }> = {
  "Asia": {
    best: ["USDJPY", "AUDUSD", "NZDUSD", "AUDJPY", "NZDJPY", "AUDCHF", "Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
    caution: "Asia session: JPY and AUD/NZD pairs most active. Indices (US30/NAS100/SPX500) are thin and gapping — avoid. Watch Tokyo fix at 04:55 UTC for JPY spikes.",
    score: 60,
    liquidity: "Medium",
  },
  "London": {
    best: ["EURUSD", "GBPUSD", "EURGBP", "EURCAD", "EURJPY", "GBPJPY", "USDCHF", "GER40", "UK100", "Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
    caution: "London session: Peak EUR, GBP, CHF liquidity. GER40 and UK100 most active. European data releases can spike EUR and GBP pairs sharply at open (08:00 UTC).",
    score: 85,
    liquidity: "High",
  },
  "London/NY Overlap": {
    best: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "GBPJPY", "US30", "NAS100", "SPX500", "GER40", "Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
    caution: "London/NY overlap: Highest global liquidity. All major pairs active. Watch US economic releases (12:30-14:00 UTC) — NFP, CPI, PPI can cause extreme moves.",
    score: 98,
    liquidity: "Very High",
  },
  "New York": {
    best: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "US30", "NAS100", "SPX500", "AAPL", "MSFT", "NVDA", "TSLA", "Volatility 75 Index", "Volatility 25 1s Index"],
    caution: "New York session: USD pairs and US indices peak. Watch for NY close (21:00 UTC) position squaring. Liquidity drops sharply after 20:00 UTC.",
    score: 80,
    liquidity: "High",
  },
  "Off-hours": {
    best: ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
    caution: "Off-hours: Interbank forex market thin. Low liquidity, very wide spreads, erratic moves. Only synthetic indices are recommended. Avoid forex and indices entirely.",
    score: 20,
    liquidity: "Low",
  },
};

function getSession(utcHour: number): keyof typeof SESSION_MARKETS {
  if (utcHour >= 0 && utcHour < 8) return "Asia";
  if (utcHour >= 8 && utcHour < 13) return "London";
  if (utcHour >= 13 && utcHour < 17) return "London/NY Overlap";
  if (utcHour >= 17 && utcHour < 22) return "New York";
  return "Off-hours";
}

function isSymbolRecommended(symbol: string, session: string): boolean {
  const sessionData = SESSION_MARKETS[session];
  if (!sessionData) return false;
  return sessionData.best.some((s) => symbol.startsWith(s) || symbol === s);
}

export function analyzeSession(category: string, symbol: string): SessionAnalysis {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const sessionKey = getSession(Math.floor(utcHour));
  const sessionData = SESSION_MARKETS[sessionKey];

  // For synthetics, session is always good (24/7)
  if (category === "synthetic") {
    return {
      session: sessionKey === "Off-hours" ? "Off-hours" : sessionKey as any,
      utcHour: Math.round(utcHour * 10) / 10,
      liquidityLevel: "High",
      recommendedMarkets: ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
      caution: "Synthetic indices trade 24/7 with consistent liquidity — no session restrictions apply.",
      sessionScore: 90,
    };
  }

  const isRecommended = isSymbolRecommended(symbol, sessionKey);
  let adjustedScore = sessionData.score;
  if (!isRecommended) {
    adjustedScore = Math.max(20, adjustedScore - 30);
  }

  return {
    session: sessionKey as any,
    utcHour: Math.round(utcHour * 10) / 10,
    liquidityLevel: sessionData.liquidity,
    recommendedMarkets: sessionData.best,
    caution: isRecommended ? sessionData.caution : `${symbol} is not optimal for ${sessionKey} session. ${sessionData.caution}`,
    sessionScore: adjustedScore,
  };
}
