import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProviderHealthPage from "./provider-health";

// A refresh that fails must not leave the last good answer looking current.
// The MT5 Candle Feed card polls every 30 s; after a failed poll it used to
// keep the green "feed connected" badge (no as-of time) next to an error.
// The broker-coverage card and the main snapshot had the same pattern after a
// failed Refresh.

const now = Date.parse("2026-10-28T11:40:00Z");

const snapshot = {
  generatedAt: new Date(now).toISOString(),
  routerChains: {},
  providers: [],
  symbolProbes: [],
  assetClassActivity: [],
  activeConsumers: [],
  summary: { totalProviders: 3, healthy: 3, degraded: 0, failing: 0, notConfigured: 0, reserved: 0, configuredButUnused: 0 },
  feeds: {
    mt5: {
      heartbeat: { present: true, status: "live", ageSec: 2, eaVersion: "1.50", accountType: "demo", masterLiveCapable: false, blockReason: null },
      quotePush: { active: true, symbolsWithFreshQuote: 3, symbolsProbed: 3, note: "" },
      candlePush: { active: true, totalSeries: 12, contributing: 12, stale: 0, nonContributing: 0 },
    },
    deriv: { configured: true, connected: true, healthSummary: "healthy", feedReadinessState: "LIVE_FEED", lastTickAt: null, message: "" },
    assistant: {
      provider: "x", connected: true, configured: true, freshnessState: "fresh", dataFreshness: null,
      dataSource: null, lastSuccessfulFetchAt: null, lastErrorAt: null, unavailableReason: null,
    },
    economicCalendar: {
      connected: true, provider: "x", eventCount: 0, configured: true, lastFetchAt: null,
      lastErrorAt: null, lastErrorMessage: null, freshnessStatus: "fresh",
    },
  },
};
const feed = {
  ok: true, feedActive: true, providerConnected: true,
  summary: { totalSeries: 12, contributing: 12, stale: 0, nonContributing: 0, unavailable: 0 },
  series: [], note: "",
};
const coverage = {
  ok: true,
  coverage: {
    totalSeries: 0, totalBarsStored: 0, totalMirroredCacheBars: 0, rows: [],
    statusCounts: { NOT_STARTED: 0, BUILDING: 0, PARTIAL: 0, COMPLETE: 4, BROKER_LIMITED: 0, ERROR: 0 },
  },
};

type Mode = "ok" | "fail";
let modes: Record<"health" | "feed" | "coverage", Mode>;

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  modes = { health: "ok", feed: "ok", coverage: "ok" };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/admin/providers/health")) {
      return modes.health === "ok" ? response({ ok: true, snapshot }) : response({ ok: false, error: "probe_failed" }, 500);
    }
    if (url.includes("/api/admin/market-data/mt5-feed")) {
      if (modes.feed === "fail") throw new TypeError("Failed to fetch");
      return response(feed);
    }
    if (url.includes("/api/admin/market-data/broker-candles")) {
      return modes.coverage === "ok" ? response(coverage) : response({ ok: false }, 503);
    }
    throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function settle() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

describe("Provider Health — a failed refresh never leaves the last answer looking current", () => {
  it("MT5 feed: after a failed 30 s poll the badge is no longer 'feed connected' and says how old the data is", async () => {
    render(<ProviderHealthPage />); await settle();
    expect(screen.getByTestId("badge-mt5-feed-active").textContent).toBe("feed connected");
    expect(screen.queryByTestId("alert-mt5-feed-stale")).toBeNull();

    modes.feed = "fail";
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    const badge = screen.getByTestId("badge-mt5-feed-active");
    expect(badge.textContent).not.toBe("feed connected");
    expect(badge.textContent).toContain("status unknown");
    expect(badge.className).not.toContain("text-success");
    expect(screen.getByTestId("alert-mt5-feed-stale").textContent).toContain("30s ago");
    expect(screen.getByTestId("alert-mt5-feed-err")).toBeTruthy();

    modes.feed = "ok";
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await settle();
    expect(screen.getByTestId("badge-mt5-feed-active").textContent).toBe("feed connected");
    expect(screen.queryByTestId("alert-mt5-feed-stale")).toBeNull();
  });

  it("broker coverage: a failed Refresh marks the shown coverage as not current", async () => {
    render(<ProviderHealthPage />); await settle();
    expect(screen.queryByTestId("alert-broker-coverage-stale")).toBeNull();
    modes.coverage = "fail";
    fireEvent.click(screen.getByTestId("btn-refresh-broker-coverage"));
    await settle();
    expect(screen.getByTestId("alert-broker-coverage-err")).toBeTruthy();
    expect(screen.getByTestId("alert-broker-coverage-stale").textContent).toContain("Not current");
  });

  it("main snapshot: a failed Refresh marks the shown snapshot as not current", async () => {
    render(<ProviderHealthPage />); await settle();
    expect(screen.queryByTestId("alert-provider-health-stale")).toBeNull();
    modes.health = "fail";
    await act(async () => { vi.advanceTimersByTime(5_000); });
    fireEvent.click(screen.getByTestId("btn-refresh-provider-health"));
    await settle();
    expect(screen.getByTestId("alert-provider-health-err")).toBeTruthy();
    expect(screen.getByTestId("alert-provider-health-stale").textContent).toContain("5s ago");
  });
});
