// CS1 regression: once a setup preview passes its server expiry it is stale,
// even after the user pressed "Use this setup" (user_confirmed). Expiry wins
// over confirmation: the button is no longer offered and the Entry/SL/TP
// overlays leave the chart.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useChartSetupPreview } from "./useChartSetupPreview";
import { canUseSetup, type SetupPreview } from "@/lib/setup-preview";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function preview(): SetupPreview {
  return {
    previewId: "p1",
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M15",
    side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: null, invalidation: 1.09 },
    rewardToRisk: 2,
    riskAmount: null,
    potentialReward: null,
    confidence: { label: "High", score: 0.8 },
    verdict: "tradeable",
    refusalReason: null,
    dataFreshness: { basis: "VERIFIED", trustLine: "ok" },
    providerSource: { assetClass: "forex", composite: false, label: "broker" },
    bridgeStatus: null,
    allocationKnown: true,
    scannerScore: null,
    flameStage: null,
    runOnQuality: null,
    riskScore: null,
    governanceOutcome: null,
    explanation: [],
    invalidationNote: "",
    createdBy: "eleanor",
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 90_000).toISOString(),
    status: "preview",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useChartSetupPreview — expiry wins over confirmation", () => {
  it.each([
    ["wrong symbol", { symbol: "GBPUSD" }],
    ["wrong timeframe", { timeframe: "H4" }],
    ["unknown timeframe", { timeframe: "bogus" }],
    ["invalid expiry", { expiresAt: "not-a-time" }],
    ["future creation", { createdAt: new Date(NOW + 10_000).toISOString() }],
  ] as const)("rejects a %s response instead of offering its chart levels", async (_name, change) => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ setupPreview: { ...preview(), ...change } }))));
    const { result } = renderHook(() => useChartSetupPreview({ symbol: "EURUSD", timeframe: "M15", aiUsable: true }));
    act(() => result.current.requestDraw());
    await waitFor(() => expect(result.current.status).not.toBe("loading"));
    expect(result.current.status).toBe("error");
    expect(result.current.preview).toBeNull();
    expect(result.current.overlays).toHaveLength(0);
  });

  it("never offers an undated preview as a ticket prefill", () => {
    expect(canUseSetup({ ...preview(), expiresAt: "not-a-time" }, "preview", NOW)).toBe(false);
  });

  it("a confirmed preview goes stale at expiry: no overlays, no 'Use this setup'", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ setupPreview: preview() }), { status: 200 })),
    );
    const { result } = renderHook(() =>
      useChartSetupPreview({ symbol: "EURUSD", timeframe: "M15", aiUsable: true }),
    );
    act(() => result.current.requestDraw());
    await waitFor(() => expect(result.current.status).toBe("ok"));
    act(() => result.current.confirm());

    expect(result.current.lifecycle).toBe("user_confirmed");
    expect(result.current.overlays.length).toBeGreaterThan(0);
    expect(canUseSetup(result.current.preview!, result.current.lifecycle)).toBe(true);

    // Past the 90 s server expiry; the real 1 s tick keeps running for
    // confirmed previews and re-renders without any user action.
    vi.setSystemTime(NOW + 91_000);
    await waitFor(() => expect(result.current.lifecycle).toBe("stale"), { timeout: 3_000 });

    expect(result.current.expired).toBe(true);
    expect(result.current.overlays).toHaveLength(0);
    expect(canUseSetup(result.current.preview!, result.current.lifecycle)).toBe(false);
    // Even if a caller passes a stale "user_confirmed" status, expiry still blocks it.
    expect(canUseSetup(result.current.preview!, "user_confirmed")).toBe(false);
  });
});
