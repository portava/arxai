// Truth regression — Provider Health "Per asset-class live activity":
//  - "Last candle" printed feedStatus.lastCandleTime as a bare local clock.
//    That field is the newest provider bar's scheduled close, which for a
//    still-forming bar is a FUTURE instant (a D1 bar's close is tomorrow
//    00:00), and a time with no date or zone cannot say which day it was.
//  - When the server could not read a class's feed status at all
//    (feedQuality "unknown"), the AI-usable column read "no" — a measured
//    verdict the server never made.
// Render proof against the REAL page, with fetch stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import ProviderHealthPage from "./provider-health";

const NOW = Date.parse("2026-10-28T14:07:00Z");

function snapshot(activity: unknown[]) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    routerChains: {},
    providers: [],
    symbolProbes: [],
    feeds: {
      mt5: {
        heartbeat: { present: false, status: "none", ageSec: null, eaVersion: null, accountType: null, masterLiveCapable: false, blockReason: null },
        quotePush: { active: false, symbolsWithFreshQuote: 0, symbolsProbed: 0, note: "" },
        candlePush: { active: false, totalSeries: 0, contributing: 0, stale: 0, nonContributing: 0 },
      },
      deriv: { configured: false, connected: false, healthSummary: "", feedReadinessState: "", lastTickAt: null, message: "" },
      assistant: { provider: "none", connected: false, configured: false, freshnessState: "", dataFreshness: null, dataSource: null, lastSuccessfulFetchAt: null, lastErrorAt: null, unavailableReason: null },
      economicCalendar: { connected: false, provider: "none", eventCount: 0, configured: false, lastFetchAt: null, lastErrorAt: null, lastErrorMessage: null, freshnessStatus: "unavailable" },
    },
    assetClassActivity: activity,
    activeConsumers: [],
    summary: { totalProviders: 0, healthy: 0, degraded: 0, failing: 0, notConfigured: 0, reserved: 0, configuredButUnused: 0 },
  };
}

function row(over: Record<string, unknown>) {
  return {
    assetClass: "forex", representativeSymbol: "EURUSD", latestCandleProvider: "mt5_broker", latestQuoteProvider: "mt5_broker",
    lastCandleTime: "2026-10-28T14:00:00.000Z", lastQuoteTime: null, aiUsable: true, feedQuality: "clean",
    staleReason: null, fallbackReason: null, ...over,
  };
}

let activity: unknown[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/admin/providers/health")) {
      return new Response(JSON.stringify({ ok: true, snapshot: snapshot(activity) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not stubbed", { status: 503 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function cells(assetClass: string): Promise<string[]> {
  render(<ProviderHealthPage />);
  const tr = await waitFor(() => screen.getByTestId(`activity-${assetClass}`));
  return [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "");
}

describe("Per asset-class live activity", () => {
  it("a forming bar's future close is labelled as a forming bar's scheduled close, with date and UTC", async () => {
    activity = [row({ assetClass: "metals", representativeSymbol: "XAUUSD", lastCandleTime: "2026-10-29T00:00:00.000Z" })];
    const last = (await cells("metals")).at(-1)!;
    expect(last).toMatch(/forming/i);
    expect(last).toContain("2026-10-29 00:00 UTC");
  });

  it("a closed bar's close reads with its date and UTC, not a bare local clock", async () => {
    activity = [row({})];
    const last = (await cells("forex")).at(-1)!;
    expect(last).toBe("closed 2026-10-28 14:00 UTC");
  });

  it("a feed status that could not be read is 'not checked', never AI usable 'no'", async () => {
    activity = [row({ assetClass: "crypto", representativeSymbol: "BTCUSD", aiUsable: false, feedQuality: "unknown", lastCandleTime: null })];
    const c = await cells("crypto");
    expect(c[5]).not.toBe("no");
    expect(c[5]).toMatch(/not checked/i);
    expect(c[4]).toMatch(/could not be read/i);
  });

  it("a measured not-usable feed still reads 'no'", async () => {
    activity = [row({ aiUsable: false, feedQuality: "stale", staleReason: "No new EURUSD bar since …" })];
    const c = await cells("forex");
    expect(c[5]).toBe("no");
  });
});
