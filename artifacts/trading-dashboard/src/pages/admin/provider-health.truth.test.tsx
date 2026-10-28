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

  it("a disconnected MT5 bridge reads 'offline' and is counted as offline, not 'reserved'", async () => {
    await renderPage(snapshot({
      providers: [provider({
        id: "mt5_broker", name: "MetaTrader 5 broker bridge", category: "broker", secretEnvKeys: [], secretMasks: [],
        status: "offline", statusReason: "No MT5 candle or quote push in the last 60 seconds.",
      })],
      summary: { totalProviders: 1, healthy: 0, degraded: 0, failing: 0, notConfigured: 0, reserved: 0, unverified: 0, offline: 1, configuredButUnused: 0 },
    }));
    const row = await screen.findByTestId("provider-mt5_broker");
    expect(within(row).getByText("offline")).toBeTruthy();
    expect(within(row).queryByText("reserved")).toBeNull();
    expect(screen.queryByText("Reserved")).toBeNull();
    expect(screen.getByText("Offline").parentElement!.textContent).toContain("1");
  });

  it("the consumer card says what it is built from, not that it traces live reads", async () => {
    await renderPage(snapshot({
      activeConsumers: [{ consumer: "scanner", providers: ["finnhub"] }],
      activeConsumersBasis: "Providers that answered this snapshot's self-test (or, for MT5 and Deriv, reported live data), mapped to the surfaces wired to them. Not a trace of each surface's reads — the router still picks a provider per request.",
    }));
    const card = await screen.findByTestId("card-active-consumers");
    expect(card.textContent).not.toMatch(/reads right now/i);
    expect(card.textContent).toMatch(/answered this snapshot's self-test/i);
    expect(card.textContent).toMatch(/not a trace/i);
  });

  it("an empty consumer list does not claim surfaces are on a fallback", async () => {
    await renderPage(snapshot());
    const card = await screen.findByTestId("card-active-consumers");
    expect(card.textContent).not.toMatch(/on a fallback/i);
    expect(card.textContent).toMatch(/No provider answered/i);
  });

  it("the MT5 heartbeat row names the master-live candidate and the freshest bridge is shown separately", async () => {
    const base = snapshot();
    await renderPage({
      ...base,
      feeds: {
        ...base.feeds,
        mt5: {
          ...base.feeds.mt5,
          heartbeat: {
            present: true, status: "offline", ageSec: 3600, eaVersion: "1.50", accountType: "live",
            masterLiveCapable: false, blockReason: "MASTER_BRIDGE_HEARTBEAT_STALE",
            subject: "master_live_candidate", readOk: true,
          },
          freshestBridge: { readOk: true, present: true, status: "live", ageSec: 2, mode: "DEMO", accountType: "demo", eaVersion: "1.50" },
        },
      },
    });
    const candidate = await screen.findByTestId("feed-mt5-heartbeat");
    expect(candidate.textContent).toMatch(/master-live candidate/i);
    expect(candidate.textContent).toMatch(/not necessarily the freshest bridge/i);
    const freshest = screen.getByTestId("feed-mt5-freshest-bridge");
    expect(within(freshest).getByText("live")).toBeTruthy();
    expect(freshest.textContent).toContain("mode DEMO");
  });

  it("a failed bridge read says 'could not be loaded', not 'none'", async () => {
    const base = snapshot();
    await renderPage({
      ...base,
      feeds: {
        ...base.feeds,
        mt5: {
          ...base.feeds.mt5,
          heartbeat: { ...base.feeds.mt5.heartbeat, subject: "master_live_candidate", readOk: false },
          freshestBridge: { readOk: false, present: false, status: "none", ageSec: null, mode: null, accountType: null, eaVersion: null },
        },
      },
    });
    const candidate = await screen.findByTestId("feed-mt5-heartbeat");
    expect(within(candidate).getByText("could not be loaded")).toBeTruthy();
    expect(within(candidate).queryByText("none")).toBeNull();
    expect(within(screen.getByTestId("feed-mt5-freshest-bridge")).getByText("could not be loaded")).toBeTruthy();
  });
});
