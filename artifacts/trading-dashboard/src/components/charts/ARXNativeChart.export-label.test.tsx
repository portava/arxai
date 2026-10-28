// Truth regression: the PNG export header must describe the feed, not stamp a
// placeholder ("Display only") or a render-time "Live at capture" verdict, and
// must carry the data time of the newest bar rather than only the wall clock.
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
  resize: vi.fn(),
  goToLatest: vi.fn(),
  fitHistory: vi.fn(),
  setScaleMode: vi.fn(),
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

const workbenchProps: Array<{ feedLabel: string }> = [];
vi.mock("./ChartWorkbenchTools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ChartWorkbenchTools")>()),
  ChartWorkbenchTools: (props: { feedLabel: string }) => { workbenchProps.push(props); return null; },
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

let SYMBOL = "EURUSD";
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

function makeResponse(closes: number[] = [1.1, 1.101, 1.102], feed: Record<string, unknown> = {}): ChartCandlesResponse {
  return {
    symbol:SYMBOL,timeframe:TF,
    candles: [
      ...closes.map((close, i) => makeCandle(NEWEST_OPEN_MS - (closes.length - 1 - i) * M5_MS, close)),
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
      ...feed,
    } as unknown as ChartFeedStatus,
    warning: null,
  } as unknown as ChartCandlesResponse;
}

const NO_OVERLAYS: never[] = [];

beforeEach(() => {
  openedStreams = [];
  workbenchProps.length = 0;
  SYMBOL = "EURUSD";
  Object.values(adapterSpies).forEach((s) => s.mockClear?.());
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const lastLabel = () => workbenchProps.at(-1)!.feedLabel;

describe("export feed label", () => {
  it("has no placeholder warning and names the newest bar's time", () => {
    currentCandleResponse = makeResponse();
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />);
    const label = lastLabel();
    expect(label).not.toContain("Display only");
    expect(label).not.toContain("Live at capture");
    expect(label).toContain(new Date(NEWEST_OPEN_MS).toISOString());
    expect(label).toContain("mt5_broker");
  });

  it("keeps a real server warning verbatim", () => {
    currentCandleResponse = makeResponse(undefined, { quality: "stale", stale: true, isLive: false, warning: "Feed is 12 minutes behind" });
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />);
    expect(lastLabel()).toContain("Feed is 12 minutes behind");
    expect(lastLabel()).toMatch(/not live-confirmed/i);
  });

  it("downgrades to not live-confirmed while the tick stream is reconnecting", () => {
    currentCandleResponse = makeResponse();
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />);
    act(() => { openedStreams[openedStreams.length - 1]!.fail(); });
    expect(lastLabel()).toMatch(/not live-confirmed/i);
    expect(lastLabel()).toMatch(/reconnecting/i);
  });
});
