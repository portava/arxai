import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProviderHealthPage from "./provider-health";

// Provider Health must describe what the server observed — a configured key
// that nothing checked is "not checked", never a green "healthy".

function provider(over: Record<string, unknown>) {
  return {
    id: "finnhub", name: "Finnhub (REST)", category: "market_data",
    secretEnvKeys: ["FINNHUB_API_KEY"], configured: true,
    secretMasks: [{ envKey: "FINNHUB_API_KEY", configured: true, lastFourMasked: "••••1234" }],
    usedBy: [], selectedForAssetClasses: [], configuredButUnused: false,
    status: "unverified", statusReason: "Key is set, but no self-test request in this snapshot reached the assistant feed, so Finnhub was not checked.",
    features: { liveQuote: true, historicalCandles: true, news: true, symbolSearch: true },
    rateLimitNote: null, lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-10-28T10:00:00Z",
    routerChains: { forex: ["mt5_broker", "assistant_real"] },
    providers: [provider({})],
    symbolProbes: [],
    feeds: {
      mt5: {
        heartbeat: { present: false, status: "none", ageSec: null, eaVersion: null, accountType: null, masterLiveCapable: false, blockReason: null },
        quotePush: { active: false, symbolsWithFreshQuote: 0, symbolsProbed: 6, note: "No fresh MT5 broker quote." },
        candlePush: { active: false, totalSeries: 0, contributing: 0, stale: 0, nonContributing: 0 },
      },
      deriv: { configured: false, connected: false, healthSummary: "unconfigured", feedReadinessState: "UNCONFIGURED", lastTickAt: null, message: "" },
      assistant: { provider: "finnhub", connected: false, configured: true, freshnessState: "NEVER_FETCHED", dataFreshness: null, dataSource: null, lastSuccessfulFetchAt: null, lastErrorAt: null, unavailableReason: null },
      economicCalendar: { connected: false, provider: "none", eventCount: 0, configured: false, lastFetchAt: null, lastErrorAt: null, lastErrorMessage: null, freshnessStatus: "unavailable" },
    },
    assetClassActivity: [],
    activeConsumers: [],
    summary: { totalProviders: 1, healthy: 0, degraded: 0, failing: 0, notConfigured: 0, reserved: 0, unverified: 1, configuredButUnused: 0 },
    ...over,
  };
}

function stubFetch(snap: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = String(url).includes("/api/admin/providers/health")
      ? { ok: true, snapshot: snap }
      : { ok: false };
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
  }));
}

async function renderPage(snap: unknown) {
  stubFetch(snap);
  render(<ProviderHealthPage />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Provider Health status truth", () => {
  it("a configured provider nothing checked shows 'not checked', not 'healthy'", async () => {
    await renderPage(snapshot());
    const row = await screen.findByTestId("provider-finnhub");
    expect(within(row).getByText("not checked")).toBeTruthy();
    expect(within(row).queryByText("healthy")).toBeNull();
    expect(within(row).getByText(/was not checked/)).toBeTruthy();
    // The summary counts it as not checked.
    const tile = screen.getByText("Not checked").parentElement!;
    expect(tile.textContent).toContain("1");
  });
});
