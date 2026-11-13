// CS6/CS7 regression (hook):
//  - Eleanor zones on the Smart Chart retire once the next candle closes after the
//    read's observedAt (chartReadExpiresAtMs), and a read is dropped when the
//    feed goes unconfirmed so it never comes back after recovery.
//  - A failed scanner fetch is reported as "unavailable", not "no signal".
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useAiChartOverlays } from "./useAiChartOverlays";

const NOW = Date.parse("2026-11-04T12:01:00.000Z");
const OBSERVED = "2026-11-04T12:00:00.000Z"; // last closed M5 candle

function stub({ scannerOk = true }: { scannerOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/market-scanner/opportunities")) {
      return scannerOk
        ? new Response(JSON.stringify({ opportunities: [], generatedAt: new Date(NOW).toISOString() }), { status: 200 })
        : new Response("busy", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        chartRead: {
          bias: "Bullish", confidence: "Medium", supportZone: "1.1000 – 1.1010",
          resistanceZone: "1.1200", dataQuality: "ok", observedAt: OBSERVED,
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
}

const eleanorOverlays = (o: { source: string }[]) => o.filter((x) => x.source === "eleanor");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAiChartOverlays Eleanor read expiry + scanner status", () => {
  it("draws Eleanor zones until the next M5 candle closes, then retires them", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stub();
    const { result } = renderHook(() => useAiChartOverlays({ symbol: "EURUSD", timeframe: "M5", aiUsable: true }));
    act(() => result.current.requestEleanorRead());
    await waitFor(() => expect(result.current.eleanor.status).toBe("ok"));
    expect(eleanorOverlays(result.current.overlays)).toHaveLength(2);
    expect(result.current.eleanor.expired).toBe(false);
    // An ISO-shaped broker timestamp does not establish a measured UTC mapping.
    expect(result.current.eleanor.asOf).toBe("12:00 source clock");

    // Jump past 12:05 (next M5 close); the deadline hook rechecks on focus.
    vi.setSystemTime(NOW + 4 * 60_000 + 1_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(result.current.eleanor.expired).toBe(true);
    expect(eleanorOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("drops the read when the feed goes unconfirmed so it cannot resurrect", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    stub();
    const { result, rerender } = renderHook(
      ({ ok }: { ok: boolean }) => useAiChartOverlays({ symbol: "EURUSD", timeframe: "M5", aiUsable: ok }),
      { initialProps: { ok: true } },
    );
    act(() => result.current.requestEleanorRead());
    await waitFor(() => expect(result.current.eleanor.status).toBe("ok"));
    rerender({ ok: false });
    rerender({ ok: true });
    expect(result.current.eleanor.read).toBeNull();
    expect(eleanorOverlays(result.current.overlays)).toHaveLength(0);
  });

  it("reports a failed scanner fetch as unavailable", async () => {
    stub({ scannerOk: false });
    const { result } = renderHook(() => useAiChartOverlays({ symbol: "EURUSD", timeframe: "M5", aiUsable: true }));
    await waitFor(() => expect(result.current.scannerStatus).toBe("unavailable"));
    expect(result.current.signal).toBeNull();
  });

  it("reports an answered scan with no row as ok (genuinely no signal)", async () => {
    stub();
    const { result } = renderHook(() => useAiChartOverlays({ symbol: "EURUSD", timeframe: "M5", aiUsable: true }));
    await waitFor(() => expect(result.current.scannerStatus).toBe("ok"));
  });
});
