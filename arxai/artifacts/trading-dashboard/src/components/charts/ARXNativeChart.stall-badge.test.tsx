// THEME C3.5 — a stalled tick-stream must SAY it is stalled.
//
// The whole failure mode being fixed in C3 is a chart that has stopped
// updating while still presenting as live. C3.4 makes the chart notice and
// reconnect; without a visible label the user still cannot tell a quiet market
// from a broken stream, so the reconnect happens invisibly and the prices on
// screen keep looking current.
//
// CONTRACT
//   - While the stream is believed down, the chart shows an honest
//     "Reconnecting — prices delayed" badge.
//   - A healthy stream shows nothing (no permanent scary badge).
//   - A frame of any kind clears it.
//   - A legitimately CLOSED market suppresses it: that is the more specific
//     explanation for the same silence, and showing both would imply a fault
//     where there is none.
//
// The badge is driven by the SAME watchdog state that drives the reconnect, so
// what the user sees and what the chart is doing cannot diverge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import type { ChartCandle, ChartCandlesResponse, ChartFeedStatus } from "@workspace/api-client-react";

let currentCandleResponse: ChartCandlesResponse | undefined;

const adapterSpies = {
  init: vi.fn(),
  destroy: vi.fn(),
  setSymbol: vi.fn(),
  setTimeframe: vi.fn(),
  setFeedState: vi.fn(),
  setCandles: vi.fn(),
  updateActiveCandle: vi.fn(),
  setOverlays: vi.fn(),
  resetScale: vi.fn(),
  setReachStartHandler: vi.fn(),
  priceToCoordinate: vi.fn(() => null),
};

vi.mock("@/lib/chart-engine", () => ({
  createChartEngineAdapter: () => adapterSpies,
}));

vi.mock("@/lib/useChartDeepHistory", () => ({
  useChartDeepHistory: () => ({
    olderCandles: [],
    loading: false,
    hasMore: false,
    providerCapped: false,
    limitationReason: null,
    coverageDays: 0,
    depthTargetDays: 0,
    loadedAny: false,
    loadOlder: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetChartCandles: () => ({
    data: currentCandleResponse,
    isLoading: false,
    isError: false,
    isFetching: false,
  }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: undefined, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({
    truth: null,
    feedStatus: null,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

import { ARXNativeChart } from "./ARXNativeChart";

interface OpenedStream {
  url: string;
  emit: (payload: unknown) => void;
  fail: () => void;
  closed: boolean;
}
let openedStreams: OpenedStream[] = [];

class MockEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly entry: OpenedStream;
  constructor(url: string) {
    this.entry = {
      url,
      closed: false,
      emit: (payload: unknown) => this.onmessage?.({ data: JSON.stringify(payload) }),
      fail: () => this.onerror?.({}),
    };
    openedStreams.push(this.entry);
  }
  close() {
    this.entry.closed = true;
  }
}

const SYMBOL = "EURUSD";
const TF = "M5";
const NEWEST_OPEN_MS = 1_700_000_000_000;
const M5_MS = 5 * 60_000;
const BADGE = "arx-native-stream-reconnecting";

function makeCandle(openMs: number, close: number): ChartCandle {
  return {
    symbol: SYMBOL,
    displaySymbol: SYMBOL,
    timeframe: TF,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + M5_MS).toISOString(),
    open: close - 0.001,
    high: close + 0.001,
    low: close - 0.002,
    close,
    volume: 100,
    tickVolume: 100,
    source: "mt5_broker",
    isComplete: true,
    isForming: false,
    sourceMode: "live",
    priceBasis: "BID",
    isFinal: true,
    receivedAt: new Date(openMs + M5_MS).toISOString(),
    qualityFlags: [],
  } as unknown as ChartCandle;
}

function makeResponse(): ChartCandlesResponse {
  return {
    candles: [
      makeCandle(NEWEST_OPEN_MS - 2 * M5_MS, 1.1),
      makeCandle(NEWEST_OPEN_MS - M5_MS, 1.101),
      makeCandle(NEWEST_OPEN_MS, 1.102),
    ],
    feedStatus: {
      symbol: SYMBOL,
      displaySymbol: SYMBOL,
      assetClass: "forex",
      source: "mt5_broker",
      isLive: true,
      lastTickTime: new Date(NEWEST_OPEN_MS).toISOString(),
      lastCandleTime: new Date(NEWEST_OPEN_MS).toISOString(),
      latencyMs: 50,
      missingCandleCount: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
      invalidOhlcCount: 0,
      stale: false,
      quality: "clean",
      warning: null,
      aiUsable: true,
      message: "live",
    } as unknown as ChartFeedStatus,
    warning: null,
  } as unknown as ChartCandlesResponse;
}

// Stable identities for both props: an inline default would be a fresh value
// each render and spin the overlay/timeframe effects. Mirrors the harness the
// sibling tick-stream suite already uses.
const NO_OVERLAYS: never[] = [];

function renderChart() {
  return render(
    <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />,
  );
}

function heartbeat() {
  act(() => {
    openedStreams[openedStreams.length - 1]!.emit({ type: "heartbeat", ts: Date.now() });
  });
}

function stallStream() {
  // The surfaced-error path reaches the same watchdog state the silence path
  // reaches, and is the one a test can trigger without faking the clock.
  act(() => {
    openedStreams[openedStreams.length - 1]!.fail();
  });
}

beforeEach(() => {
  openedStreams = [];
  currentCandleResponse = makeResponse();
  Object.values(adapterSpies).forEach((s) => s.mockClear?.());
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("C3.5 — stalled-stream badge", () => {
  it("shows nothing on a healthy stream", () => {
    renderChart();
    heartbeat();
    expect(screen.queryByTestId(BADGE)).toBeNull();
  });

  it("appears when the stream stalls", () => {
    renderChart();
    stallStream();
    const badge = screen.getByTestId(BADGE);
    expect(badge.textContent).toMatch(/reconnecting/i);
    expect(badge.textContent).toMatch(/delayed/i);
  });

  it("says prices are not updating rather than implying they are current", () => {
    renderChart();
    stallStream();
    const badge = screen.getByTestId(BADGE);
    expect(badge.getAttribute("title")).toMatch(/not updating/i);
  });

  it("clears once a frame arrives again", () => {
    renderChart();
    stallStream();
    expect(screen.queryByTestId(BADGE)).not.toBeNull();
    heartbeat();
    expect(screen.queryByTestId(BADGE)).toBeNull();
  });

  it("is suppressed while the market is legitimately closed", () => {
    renderChart();
    // A closed market explains the same silence more specifically.
    act(() => {
      openedStreams[0]!.emit({
        type: "feed_status",
        symbol: SYMBOL,
        timeframe: TF,
        marketFrozen: true,
        lastBrokerTimeMs: NEWEST_OPEN_MS,
        ts: Date.now(),
      });
    });
    stallStream();
    expect(screen.queryByTestId(BADGE)).toBeNull();
    expect(screen.queryByTestId("arx-native-market-closed")).not.toBeNull();
  });

  it("returns once the market-closed verdict is lifted and the stream is still down", () => {
    renderChart();
    act(() => {
      openedStreams[0]!.emit({
        type: "feed_status",
        symbol: SYMBOL,
        timeframe: TF,
        marketFrozen: true,
        lastBrokerTimeMs: NEWEST_OPEN_MS,
        ts: Date.now(),
      });
    });
    stallStream();
    expect(screen.queryByTestId(BADGE)).toBeNull();

    // feed_status counts as a frame, so clear the stall first, then re-stall.
    act(() => {
      openedStreams[0]!.emit({
        type: "feed_status",
        symbol: SYMBOL,
        timeframe: TF,
        marketFrozen: false,
        lastBrokerTimeMs: NEWEST_OPEN_MS,
        ts: Date.now(),
      });
    });
    stallStream();
    expect(screen.queryByTestId(BADGE)).not.toBeNull();
  });
});
