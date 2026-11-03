// Market Brain: POST /brain/analyze answers either with a full analysis of
// REAL router candles or with the honest refusal
// { available:false, reason:"INSUFFICIENT_REAL_DATA" } (api-server
// brain/marketBrain.ts). The page must render the refusal as "not enough real
// candles", not crash on its missing details, must not call real candles
// "simulated", and must say where the candles came from.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  analysis: null as unknown,
  fail: false,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRunBrainAnalysisMutationOptions: () => ({
    mutationFn: async () => {
      if (h.fail) throw new Error("HTTP 500");
      return h.analysis;
    },
  }),
  getGetBrainSymbolsQueryKey: () => ["brain-symbols"],
  getBrainSymbols: async () => [{ symbol: "EURUSD", displayName: "EUR/USD", brokerSymbol: "EURUSD" }],
}));

const { default: BrainAnalysis } = await import("./brain-analysis");

// Exactly the shape refuseInsufficientRealData() returns.
const REFUSAL = {
  available: false,
  reason: "INSUFFICIENT_REAL_DATA",
  symbol: "EURUSD",
  direction: "WAIT",
  confidence: 0,
  riskApproved: false,
  blockedReason: "INSUFFICIENT_REAL_DATA: only 12/60 real closed candles available from deriv",
  reasons: [
    "INSUFFICIENT_REAL_DATA: only 12/60 real closed candles available from deriv",
    "ARX does not analyze fabricated candles — analysis is withheld until a real feed serves enough closed bars.",
  ],
  timestamp: new Date().toISOString(),
};

const FULL = {
  available: true,
  symbol: "EURUSD", category: "forex", direction: "BUY", confidence: 72,
  entry: 1.08512, stopLoss: 1.08401, takeProfit: 1.08697, riskReward: 1.67,
  strategy: "Trend Continuation", marketCondition: "Strong Uptrend",
  technicalBias: "Bullish", macroBias: "Neutral", session: "London", newsRisk: "Medium",
  riskApproved: true, blockedReason: "", reasons: ["Trend up"], timestamp: new Date().toISOString(),
  scoring: {
    confidence: 72,
    breakdown: {
      technicalContrib: 36, macroContrib: 10, sessionContrib: 9, strategyContrib: 12.8,
      newsDeduction: 8, volatilityDeduction: 0, spreadDeduction: 0,
      formula: "technicalScore×0.45 + macro×0.20 + session×0.10 + strategy×0.15 − penalties",
    },
  },
  symbolInfo: null,
  technicalDetails: {
    trendDirection: "Bullish", trendStrength: 70, emaAlignment: "Full Bull", rsiState: "Bullish",
    rsiValue: 61, atrState: "Normal", atrValue: 0.0007, structure: "Higher Highs", liquiditySweep: "None",
    chopScore: 30, volatilityExpansion: false, supportLevels: [], resistanceLevels: [],
  },
  macroDetails: {
    type: "unavailable", providerConnected: false, macroBias: "Neutral", macroScore: 50,
    safetyNote: "No live macro/fundamentals provider is connected.", notes: [],
  },
  sessionDetails: { session: "London", liquidityLevel: "High", recommendedMarkets: [], caution: "None", sessionScore: 90 },
  newsDetails: { majorNewsSoon: true, riskLevel: "Medium", blockTrading: false, reason: "CPI in 3h", providerConnected: true },
  candleSource: "deriv",
  candleCount: 250,
};

async function run(analysis: unknown, fail = false) {
  h.analysis = analysis;
  h.fail = fail;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><BrainAnalysis /></QueryClientProvider>);
  await screen.findByText("EUR/USD (EURUSD)");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "EURUSD" } });
  fireEvent.click(screen.getByText("Run Brain Analysis"));
}

afterEach(cleanup);

describe("Market Brain truth — refusal and provenance", () => {
  it("renders the INSUFFICIENT_REAL_DATA refusal instead of crashing", async () => {
    await run(REFUSAL);
    const card = await screen.findByTestId("brain-refusal");
    expect(card.textContent).toMatch(/not enough real candles/i);
    expect(card.textContent).toMatch(/only 12\/60 real closed candles available from deriv/i);
    expect(screen.queryByText("Confluence Scoring")).toBeNull();
    expect(screen.queryByText(/Approved/)).toBeNull();
  });

  it("a full analysis of real candles is not called simulated and names its source", async () => {
    await run(FULL);
    const prov = await screen.findByTestId("brain-provenance");
    expect(document.body.textContent).not.toMatch(/simulated/i);
    expect(prov.textContent).toMatch(/250 1-minute candles served by deriv/);
    expect(prov.textContent).toMatch(/1-minute ATR/);
  });

  it("a failed request says it could not be loaded", async () => {
    await run(null, true);
    const err = await screen.findByTestId("brain-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
  });
});

describe("Market Brain truth — news risk without a calendar", () => {
  const NO_CALENDAR = {
    ...FULL,
    newsRisk: "Low",
    newsDetails: { majorNewsSoon: false, riskLevel: "Low", blockTrading: false, reason: "x", providerConnected: false },
  };

  it("'Low' with providerConnected:false is shown as unknown, never a green Low", async () => {
    await run(NO_CALENDAR);
    const level = await screen.findByTestId("brain-news-level");
    expect(level.textContent).toMatch(/unknown/i);
    expect(level.textContent).toMatch(/not connected/i);
    expect(level.className).not.toMatch(/emerald/);
    expect(screen.getByTestId("brain-news-unknown").textContent).toMatch(/unknown, not clear/i);
    expect(screen.queryByText("Low")).toBeNull();
  });

  it("the bias row does not read 'News Risk: Low' when no calendar was read", async () => {
    await run(NO_CALENDAR);
    await screen.findByTestId("brain-news-level");
    expect(screen.getByText("Unknown (no calendar)")).toBeTruthy();
  });

  it("a connected calendar's Low is still shown as Low", async () => {
    await run({ ...NO_CALENDAR, newsDetails: { ...NO_CALENDAR.newsDetails, providerConnected: true } });
    const level = await screen.findByTestId("brain-news-level");
    expect(level.textContent).toBe("Low");
    expect(screen.queryByTestId("brain-news-unknown")).toBeNull();
  });
});

describe("Market Brain truth — withheld macro and the risk badge", () => {
  const S = "SAFETY-NOTE-S";
  const WITHHELD = {
    ...FULL,
    macroBias: "Neutral",
    macroDetails: { type: "unavailable", providerConnected: false, macroBias: "Neutral", macroScore: 50, safetyNote: S, notes: [] },
  };

  it("withheld macro shows its safety note, not a 50% Macro Score or a Neutral bias", async () => {
    await run(WITHHELD);
    const panel = await screen.findByTestId("brain-macro-withheld");
    expect(panel.textContent).toContain(S);
    expect(screen.queryByText("Macro Score")).toBeNull();
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("Neutral")).toBeNull();
    expect(screen.getByText("Not available (no macro data)")).toBeTruthy();
  });

  it("the placeholder macro contribution is named as a placeholder, not a Macro Contrib bar", async () => {
    await run(WITHHELD);
    await screen.findByTestId("brain-macro-withheld");
    expect(screen.queryByText("Macro Contrib")).toBeNull();
    expect(screen.getByTestId("brain-macro-placeholder-contrib").textContent).toMatch(/\+10 from a fixed neutral placeholder/);
  });

  it("the risk badge never says Approved and says account risk was not checked", async () => {
    await run(WITHHELD);
    const badge = await screen.findByTestId("brain-filter-badge");
    expect(badge.textContent).not.toMatch(/approved/i);
    expect(badge.className).not.toMatch(/emerald/);
    expect(document.body.textContent).not.toMatch(/Approved/);
    expect(screen.getByTestId("brain-risk-not-checked").textContent).toMatch(/account risk not checked/i);
  });

  it("synthetic 'Not news-driven' is not styled like a Bearish bias", async () => {
    await run({
      ...FULL,
      category: "synthetic",
      macroBias: "Not news-driven",
      macroDetails: { type: "synthetic", macroBias: "Not news-driven", macroScore: 50, notes: [] },
    });
    await screen.findByTestId("brain-provenance");
    for (const el of screen.getAllByText("Not news-driven")) {
      expect(el.className).not.toMatch(/red/);
    }
  });
});
