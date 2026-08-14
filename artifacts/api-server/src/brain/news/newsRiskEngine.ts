// News Risk Engine — detects upcoming high-impact economic events and blocks/warns trading

export interface NewsRiskAnalysis {
  majorNewsSoon: boolean;
  affectedCurrencies: string[];
  affectedIndices: string[];
  riskLevel: "Low" | "Medium" | "High" | "Critical";
  blockTrading: boolean;
  reason: string;
  nextEvent?: string;
}

interface NewsEvent {
  name: string;
  utcHourRange: [number, number];
  days?: number[];
  affectedCurrencies: string[];
  affectedIndices: string[];
  impact: "High" | "Medium";
  blockWindow: number;
}

const NEWS_SCHEDULE: NewsEvent[] = [
  // Monday — Tokyo BOJ watch
  { name: "BOJ Policy Statement (watch)", utcHourRange: [23.5, 24], days: [0, 1], affectedCurrencies: ["JPY"], affectedIndices: ["JP225"], impact: "High", blockWindow: 0.5 },
  // Wednesday — US CPI typical release
  { name: "US Consumer Price Index (CPI)", utcHourRange: [12.5, 13.5], days: [3], affectedCurrencies: ["USD", "EUR"], affectedIndices: ["US30", "NAS100", "SPX500"], impact: "High", blockWindow: 0.75 },
  // Wednesday — ECB Rate Statement (alt weeks)
  { name: "ECB Interest Rate Decision", utcHourRange: [11.75, 12.5], days: [4], affectedCurrencies: ["EUR", "USD"], affectedIndices: ["GER40"], impact: "High", blockWindow: 1 },
  // Wednesday — FOMC Statement
  { name: "FOMC Rate Decision", utcHourRange: [18.0, 19.5], days: [3], affectedCurrencies: ["USD"], affectedIndices: ["US30", "NAS100", "SPX500"], impact: "High", blockWindow: 1.5 },
  // Thursday — BOE rate decision (alt weeks)
  { name: "Bank of England Rate Decision", utcHourRange: [12.0, 13.0], days: [4], affectedCurrencies: ["GBP", "USD"], affectedIndices: ["UK100"], impact: "High", blockWindow: 1 },
  // Thursday — US Jobless claims
  { name: "US Jobless Claims", utcHourRange: [12.5, 13.0], days: [4], affectedCurrencies: ["USD"], affectedIndices: ["US30", "SPX500"], impact: "Medium", blockWindow: 0.5 },
  // Friday — US NFP (first Friday of month)
  { name: "US Nonfarm Payrolls (NFP)", utcHourRange: [12.5, 13.5], days: [5], affectedCurrencies: ["USD", "EUR", "GBP", "JPY", "AUD"], affectedIndices: ["US30", "NAS100", "SPX500"], impact: "High", blockWindow: 1.0 },
  // Friday — US Retail Sales (varies)
  { name: "US Retail Sales", utcHourRange: [12.5, 13.0], days: [5], affectedCurrencies: ["USD"], affectedIndices: ["US30", "SPX500"], impact: "Medium", blockWindow: 0.5 },
  // Monday — UK CPI (varies)
  { name: "UK CPI", utcHourRange: [7.0, 8.0], days: [2], affectedCurrencies: ["GBP", "EUR"], affectedIndices: ["UK100"], impact: "High", blockWindow: 0.5 },
  // Daily — US session open liquidity spike
  { name: "US Market Open Liquidity Spike", utcHourRange: [13.25, 13.75], days: [1, 2, 3, 4, 5], affectedCurrencies: ["USD"], affectedIndices: ["US30", "NAS100", "SPX500"], impact: "Medium", blockWindow: 0.25 },
  // Daily — Fed Chair speech (simulated)
  { name: "Fed Chair Speech (simulated)", utcHourRange: [17.5, 18.25], days: [2, 4], affectedCurrencies: ["USD", "EUR"], affectedIndices: ["US30", "NAS100"], impact: "High", blockWindow: 0.5 },
  // Japan GDP
  { name: "Japan GDP (quarterly release)", utcHourRange: [23.5, 0.5], days: [2], affectedCurrencies: ["JPY"], affectedIndices: ["JP225"], impact: "High", blockWindow: 0.5 },
];

function isSymbolAffected(symbol: string, currencies: string[], indices: string[]): boolean {
  // Check if symbol contains any affected currency
  for (const c of currencies) {
    if (symbol.includes(c)) return true;
  }
  // Check if symbol matches an index
  for (const idx of indices) {
    if (symbol === idx || symbol.startsWith(idx)) return true;
  }
  return false;
}

export function analyzeNewsRisk(symbol: string, category: string): NewsRiskAnalysis {
  // Synthetic indices are never affected by news
  if (category === "synthetic") {
    return { majorNewsSoon: false, affectedCurrencies: [], affectedIndices: [], riskLevel: "Low", blockTrading: false, reason: "Synthetic indices are immune to real-world economic news. No news filter applied." };
  }

  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon...

  const activeEvents: NewsEvent[] = [];
  const soonEvents: NewsEvent[] = [];

  for (const event of NEWS_SCHEDULE) {
    if (event.days && !event.days.includes(utcDay)) continue;
    const [start, end] = event.utcHourRange;
    const windowStart = start - event.blockWindow;
    const windowEnd = end + event.blockWindow * 0.5;
    if (utcHour >= windowStart && utcHour <= windowEnd) {
      if (isSymbolAffected(symbol, event.affectedCurrencies, event.affectedIndices)) {
        if (utcHour >= start && utcHour <= end) {
          activeEvents.push(event);
        } else {
          soonEvents.push(event);
        }
      }
    }
  }

  if (activeEvents.length > 0) {
    const critical = activeEvents.find((e) => e.impact === "High");
    const allCurrencies = [...new Set(activeEvents.flatMap((e) => e.affectedCurrencies))];
    const allIndices = [...new Set(activeEvents.flatMap((e) => e.affectedIndices))];
    return {
      majorNewsSoon: true,
      affectedCurrencies: allCurrencies,
      affectedIndices: allIndices,
      riskLevel: critical ? "Critical" : "High",
      blockTrading: !!critical,
      reason: `🚨 ACTIVE: ${activeEvents.map((e) => e.name).join(", ")}. ${critical ? "High-impact event — trading blocked." : "Medium-impact event — proceed with caution."}`,
      nextEvent: activeEvents[0].name,
    };
  }

  if (soonEvents.length > 0) {
    const critical = soonEvents.find((e) => e.impact === "High");
    const allCurrencies = [...new Set(soonEvents.flatMap((e) => e.affectedCurrencies))];
    const allIndices = [...new Set(soonEvents.flatMap((e) => e.affectedIndices))];
    const minutesToEvent = Math.round((soonEvents[0].utcHourRange[0] - utcHour) * 60);
    return {
      majorNewsSoon: true,
      affectedCurrencies: allCurrencies,
      affectedIndices: allIndices,
      riskLevel: critical ? "High" : "Medium",
      blockTrading: false,
      reason: `⚠️ UPCOMING (${minutesToEvent > 0 ? `~${minutesToEvent} min` : "passing"}): ${soonEvents.map((e) => e.name).join(", ")}. ${critical ? "Avoid new positions — high-impact event approaching." : "Caution — news approaching."}`,
      nextEvent: soonEvents[0].name,
    };
  }

  return {
    majorNewsSoon: false,
    affectedCurrencies: [],
    affectedIndices: [],
    riskLevel: "Low",
    blockTrading: false,
    reason: "No major economic events detected for this symbol in the current time window.",
  };
}
