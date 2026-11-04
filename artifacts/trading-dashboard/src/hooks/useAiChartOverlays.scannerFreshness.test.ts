// Truth regression: the live chart may only draw "Scanner BUY/SELL" entry, stop
// and target lines from a scan row the scanner page itself would still act on
// (a recent scan, a live and tradeable row, a final read that is not
// NO_TRADE / AVOID / WAIT). A row from another timeframe must name that
// timeframe on every drawn level.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useAiChartOverlays } from "./useAiChartOverlays";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

type Row = Record<string, unknown>;

function row(over: Row = {}): Row {
  return {
    symbol: "EURUSD",
    timeframe: "1m",
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: 71,
    statusBadge: "STRONG_SETUP",
    entry: 1.085,
    stopLoss: 1.08,
    takeProfit: 1.095,
    dataSource: "LIVE_FEED",
    dataStatus: "live",
    tradeable: true,
    generatedAt: new Date(NOW - 5_000).toISOString(),
    finalRead: { label: "TRADE_WATCH", headline: "Setup is on watch." },
    ...over,
  };
}

function stubScanner(rows: Row[], envelopeGeneratedAt: string | null = new Date(NOW - 5_000).toISOString()) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ opportunities: rows, generatedAt: envelopeGeneratedAt }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderOverlays(timeframe = "1m") {
  const hook = renderHook(() => useAiChartOverlays({ symbol: "EURUSD", timeframe, aiUsable: true }));
  await waitFor(() => expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0));
  // Let the fetch promise chain settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return hook;
}

function signalOverlays(overlays: { source: string; id: string }[]) {
  return overlays.filter((o) => o.source === "signal" && o.id.startsWith("sig-"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAiChartOverlays scanner signal truth", () => {
  it("draws a current, live, tradeable, same-timeframe watch row", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row()]);
    const { result } = await renderOverlays();
    await waitFor(() => expect(result.current.signal).not.toBeNull());
    expect(signalOverlays(result.current.overlays)).toHaveLength(4);
  });

  it("draws nothing from a scan that ran 2 hours ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const old = new Date(NOW - 2 * 3600_000).toISOString();
    stubScanner([row({ timeframe: "H4", generatedAt: old })], old);
    const { result } = await renderOverlays();
    expect(result.current.signal).toBeNull();
    expect(signalOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("draws nothing when the envelope scan time is old even if the row stamp looks fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row()], new Date(NOW - 2 * 3600_000).toISOString());
    const { result } = await renderOverlays();
    expect(result.current.signal).toBeNull();
    expect(signalOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("draws no marker when the row's final read is NO_TRADE", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row({ finalRead: { label: "NO_TRADE", headline: "Major event nearby." } })]);
    const { result } = await renderOverlays();
    expect(result.current.signal).toBeNull();
    expect(result.current.overlays.some((o) => o.type === "marker" && o.source === "signal")).toBe(false);
  });

  it("draws no marker when the row's final read says wait for confirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row({ finalRead: { label: "WAIT_FOR_CONFIRMATION", headline: "Confirm first." } })]);
    const { result } = await renderOverlays();
    expect(signalOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("draws no marker when the row's data status is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row({ dataStatus: "stale", tradeable: false })]);
    const { result } = await renderOverlays();
    expect(result.current.signal).toBeNull();
    expect(signalOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("names the row's timeframe on every drawn level when it differs from the chart", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stubScanner([row({ timeframe: "H4" })]);
    const { result } = await renderOverlays("1m");
    await waitFor(() => expect(result.current.signal).not.toBeNull());
    const sig = signalOverlays(result.current.overlays) as Array<{ label: string }>;
    expect(sig).toHaveLength(4);
    for (const o of sig) expect(o.label).toContain("H4");
  });

  it("clears the drawn levels once the scan passes its 30 second limit", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: NOW });
    const fetchMock = stubScanner([row()]);
    const { result } = renderHook(() => useAiChartOverlays({ symbol: "EURUSD", timeframe: "1m", aiUsable: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.signal).not.toBeNull();
    // Every later poll returns the same scan (the engine stopped). Between
    // polls the row ages past 30 s, and the drawn levels must go with it.
    await act(async () => { vi.advanceTimersByTime(20_000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.signal).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(6_000); await Promise.resolve(); });
    expect(signalOverlays(result.current.overlays)).toHaveLength(0);
  });
});
