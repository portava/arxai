// Live AI Assist trade card: anything the selected-market read did not supply
// (entry zone, stop, target, confidence, R:R) is shown as "Not provided" and
// submitted as null — never 0 shown or captured as a measured value. There is
// no risk score (the read never computes one), the setup text never invents
// "Live setup", and the card says which feed the read came from and as of when.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/charts/TradingViewLiveChart", () => ({ default: () => null }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: false, loaded: true }),
}));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ effectiveIsAdmin: false }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: LiveAiAssistPage, snapshotToState } = await import("./live-ai-assist");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Shape of SelectedMarketResult (api-server/src/lib/scannerSelected/selectedMarket.ts)
// with a directional read whose levels were withheld by the stale-level guard.
const WITHHELD = {
  ok: true, symbol: "EURUSD", symbolRaw: "EURUSD", timeframe: "M15",
  highlights: {
    bias: "BUY", confidenceLabel: "Medium", confidenceScore: 61, volatilityLabel: "Normal",
    trendState: "bullish", entryZone: null, suggestedStop: null, suggestedTakeProfit: null,
    riskRewardRatio: 0, riskWarnings: [],
  },
  explanation: { why: "Higher highs on M15.", invalidation: "Close below 1.0800." },
  dataSource: "LIVE_FEED", dataSourceLabel: "MT5 broker feed", dataState: "LIVE_CONFIRMED",
  dataAsOf: "2026-10-28T09:00:00.000Z", liveClaimExpiresAt: "2026-10-28T09:30:00.000Z",
  levelsWithheld: true,
  levelsWithheldReason: "Saved levels drifted too far from the current price.",
  readWithheldReason: null, generatedAt: "2026-10-28T09:01:00.000Z", cacheHit: false,
};

function serve(snapshot: unknown) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/market-scanner/selected-market")) return new Response(JSON.stringify(snapshot));
    if (url.includes("/live-intent/submit")) {
      return new Response(JSON.stringify({ accepted: false, riskCheckPassed: false, status: "REJECTED_BY_RISK", reason: "Risk check failed: stopLoss is required for live-intent capture", intentId: "intent_1" }));
    }
    return new Response(JSON.stringify({}));
  }));
  return calls;
}

describe("Live AI Assist card truth", () => {
  it("withheld levels and missing scores stay null, never 0", () => {
    const st = snapshotToState(WITHHELD);
    expect(st.kind).toBe("card");
    if (st.kind !== "card") return;
    expect(st.card.entry).toBeNull();
    expect(st.card.stopLoss).toBeNull();
    expect(st.card.takeProfit).toBeNull();
    expect(st.card.riskRewardRatio).toBeNull();
    expect("riskScore" in st.card).toBe(false);
    const noConf = snapshotToState({ ...WITHHELD, highlights: { ...WITHHELD.highlights, confidenceScore: undefined } });
    expect(noConf.kind === "card" && noConf.card.confidenceScore).toBeNull();
  });

  it("setup text never falls back to an invented 'Live setup'", () => {
    const st = snapshotToState({ ...WITHHELD, highlights: { ...WITHHELD.highlights, trendState: undefined } });
    expect(st.kind === "card" && st.card.setup).not.toBe("Live setup");
    expect(st.kind === "card" && st.card.setup).toMatch(/not stated/i);
  });

  it("a read the server did not confirm as live never becomes a directional card", () => {
    expect(snapshotToState({ ...WITHHELD, dataState: "STALE" }).kind).toBe("nodata");
    expect(snapshotToState({ ...WITHHELD, dataState: undefined }).kind).toBe("nodata");
  });

  it("card shows Not provided, the withheld reason, the source and as-of time; submit sends nulls", async () => {
    const calls = serve(WITHHELD);
    render(<LiveAiAssistPage />);
    fireEvent.click(screen.getByTestId("generate-card"));
    await screen.findByTestId("approve-card");
    expect(screen.getByTestId("ai-card-entry").textContent).toContain("Not provided");
    expect(screen.getByTestId("ai-card-sl").textContent).toContain("Not provided");
    expect(screen.getByTestId("ai-card-tp").textContent).toContain("Not provided");
    expect(screen.getByTestId("ai-card-rr").textContent).toContain("Not provided");
    expect(screen.getByTestId("ai-card-confidence").textContent).toContain("61/100");
    expect(screen.getByTestId("ai-card-levels-withheld").textContent).toContain("drifted too far");
    const prov = screen.getByTestId("ai-card-provenance").textContent ?? "";
    expect(prov).toContain("MT5 broker feed");
    expect(prov).toContain("2026-10-28 09:00 UTC");

    fireEvent.click(screen.getByTestId("approve-card"));
    await screen.findByTestId("ai-assist-response");
    const submit = calls.find((c) => c.url.includes("/live-intent/submit"))!.body as Record<string, unknown>;
    expect(submit.entryPrice).toBeNull();
    expect(submit.stopLoss).toBeNull();
    expect(submit.takeProfit).toBeNull();
    expect(submit.riskRewardRatio).toBeNull();
    expect(submit.riskScore).toBeNull();
    expect(submit.confidenceScore).toBe(61);
  });
});
