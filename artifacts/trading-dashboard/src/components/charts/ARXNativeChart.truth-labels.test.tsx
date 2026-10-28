// ARXNativeChart — every header / mirror-layer / empty-state label must
// describe what was actually observed (truth upgrade, 2026-10-28).
//
// Each block below pins one inaccuracy that used to reach the screen:
//   - a "Reconnecting — prices delayed" badge on charts that never opened a
//     tick stream (third-party candle source, or no feed at all).
//   - an AI chip reading "No AI" while the same panel kept AI overlays live
//     (the "Not AI-confirmed" badge and the aiUsable context reported to the
//     page used the uncapped raw feed flag).
//   - a "Mirror Layer" strip that read "Mirrored" over delayed/partial data,
//     flipped to "Refreshing" on every poll (hiding "Stale"/"Conflict"), read
//     "Syncing · Waiting for data" when every provider had declined, and showed
//     a "Lock ON/OFF" toggle that locked nothing.
//   - a LIVE last-price line, "Clean · AI" chip and clean strip kept on screen
//     after the chart's own candle refresh failed (frozen cached response).
//   - "Chart data is syncing — waiting for a live feed to connect" when the
//     router had exhausted every provider (the server's own message dropped).
//   - a header chip whose cap came from a different candle window and poll
//     cadence (200 bars / 15 s) than the chip text (300 bars / 8 s).
//
// The harness renders the REAL ARXNativeChart with the candle query, the
// chart engine and the scanner-truth hook replaced by controllable stubs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import type { ChartCandle, ChartCandlesResponse, ChartFeedStatus } from "@workspace/api-client-react";

interface CandleQueryStub {
  data: ChartCandlesResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

let candleQuery: CandleQueryStub;

const adapterSpies = {
  init: vi.fn(),
  destroy: vi.fn(),
  setSymbol: vi.fn(),
  setTimeframe: vi.fn(),
  setFeedState: vi.fn(),
  setCandles: vi.fn(),
  updateActiveCandle: vi.fn(),
  setOverlays: vi.fn(),
  setStructureLines: vi.fn(),
  resetScale: vi.fn(),
  resize: vi.fn(),
  goToLatest: vi.fn(),
  fitHistory: vi.fn(),
  setScaleMode: vi.fn(),
  setReachStartHandler: vi.fn(),
  priceToCoordinate: vi.fn(() => null),
  setDisplayPricePrecision: vi.fn(),
};

vi.mock("@/lib/chart-engine", () => ({
  createChartEngineAdapter: () => adapterSpies,
}));

vi.mock("@/lib/useChartDeepHistory", () => ({
  useChartDeepHistory: () => ({
    olderCandles: [],
    analysisEvidence: null,
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
  useGetChartCandles: () => ({ ...candleQuery, refetch: vi.fn() }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: undefined, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

// The scanner-truth hook is the cap source. Each test sets the analysis level
// it resolves to; every call's arguments are recorded.
let truthLevel: "full" | "limited" | "historical_only" | "blocked" | null = "full";
const scannerTruthCalls: unknown[][] = [];
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => {
    scannerTruthCalls.push(args);
    return {
      truth: truthLevel == null ? null : { analysis: { level: truthLevel } },
      feedStatus: null,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  },
}));

import { ARXNativeChart } from "./ARXNativeChart";

let openedStreams: string[] = [];
let openedSources: MockEventSource[] = [];
class MockEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    openedStreams.push(url);
    openedSources.push(this);
  }
  close() {}
}

const SYMBOL = "EURUSD";
const TF = "M5";
const NEWEST_OPEN_MS = 1_700_000_000_000;
const M5_MS = 5 * 60_000;
const RECONNECTING = "arx-native-stream-reconnecting";

function makeCandle(openMs: number, close: number, source: string): ChartCandle {
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
    source,
    isComplete: true,
    isForming: false,
    sourceMode: "live",
    priceBasis: "BID",
    isFinal: true,
    receivedAt: new Date(openMs + M5_MS).toISOString(),
    qualityFlags: [],
  } as unknown as ChartCandle;
}

function makeFeedStatus(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
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
    ...over,
  } as unknown as ChartFeedStatus;
}

function makeResponse(over: Partial<ChartFeedStatus> = {}): ChartCandlesResponse {
  const feedStatus = makeFeedStatus(over);
  const source = String(feedStatus.source);
  return {
    symbol: SYMBOL,
    timeframe: TF,
    candles: [
      makeCandle(NEWEST_OPEN_MS - 2 * M5_MS, 1.1, source),
      makeCandle(NEWEST_OPEN_MS - M5_MS, 1.101, source),
      makeCandle(NEWEST_OPEN_MS, 1.102, source),
    ],
    feedStatus,
    warning: null,
  } as unknown as ChartCandlesResponse;
}

function emptyResponse(over: Partial<ChartFeedStatus>): ChartCandlesResponse {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    candles: [],
    feedStatus: makeFeedStatus({ isLive: false, aiUsable: false, ...over }),
    warning: over.warning ?? null,
  } as unknown as ChartCandlesResponse;
}

function setResponse(data: ChartCandlesResponse | undefined, over: Partial<CandleQueryStub> = {}) {
  candleQuery = { data, isLoading: false, isError: false, isFetching: false, ...over };
}

const NO_OVERLAYS: never[] = [];

function renderChart(props: Partial<Parameters<typeof ARXNativeChart>[0]> = {}) {
  return render(
    <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus overlays={NO_OVERLAYS} {...props} />,
  );
}

beforeEach(() => {
  openedStreams = [];
  openedSources = [];
  scannerTruthCalls.length = 0;
  truthLevel = "full";
  setResponse(makeResponse());
  Object.values(adapterSpies).forEach((s) => s.mockClear?.());
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("reconnecting badge only describes a tick stream that exists", () => {
  it("never claims a reconnect on a third-party candle source (no stream is opened)", () => {
    vi.useFakeTimers();
    setResponse(makeResponse({ source: "assistant_real:twelve_data" }));
    renderChart();
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(openedStreams).toHaveLength(0);
    expect(screen.queryByTestId(RECONNECTING)).toBeNull();
  });

  it("never claims a reconnect when there is no feed at all", () => {
    vi.useFakeTimers();
    setResponse(undefined);
    renderChart();
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(openedStreams).toHaveLength(0);
    expect(screen.queryByTestId(RECONNECTING)).toBeNull();
  });

  it("still flags a real broker stream that reports an error", () => {
    renderChart();
    expect(openedStreams).toHaveLength(1);
    act(() => { openedSources[0]!.onerror?.({}); });
    expect(screen.queryByTestId(RECONNECTING)).not.toBeNull();
  });
});

describe("AI usability is one verdict across chip, badge and page context", () => {
  it.each([["historical_only"], ["limited"], [null]] as const)(
    "a %s scanner truth over a clean feed reads not-AI everywhere",
    (level) => {
      truthLevel = level;
      const onChartContextChange = vi.fn();
      renderChart({ onChartContextChange });
      const chip = screen.getByTestId("arx-feed-badge");
      expect(chip.getAttribute("data-ai-usable")).toBe("false");
      // The badge must agree with the chip, not with the raw feed flag.
      expect(screen.queryByTestId("arx-native-not-ai")).not.toBeNull();
      // The page sources AI overlays from this context: it must be told "no".
      const last = onChartContextChange.mock.calls.at(-1)?.[0] as { aiUsable: boolean };
      expect(last.aiUsable).toBe(false);
    },
  );

  it("a full scanner truth over a clean feed keeps AI usable", () => {
    const onChartContextChange = vi.fn();
    renderChart({ onChartContextChange });
    expect(screen.getByTestId("arx-feed-badge").getAttribute("data-ai-usable")).toBe("true");
    expect(screen.queryByTestId("arx-native-not-ai")).toBeNull();
    const last = onChartContextChange.mock.calls.at(-1)?.[0] as { aiUsable: boolean };
    expect(last.aiUsable).toBe(true);
  });
});

describe("feed strip says what the server graded, never an unmeasured mirror", () => {
  const strip = () => screen.getByTestId("arx-mirror-status").textContent ?? "";

  it.each([
    ["delayed", "Delayed"],
    ["partial", "Partial"],
  ] as const)("a %s feed is not shown as mirrored", (quality, label) => {
    setResponse(makeResponse({ quality, isLive: false, aiUsable: false }));
    renderChart();
    expect(strip()).not.toMatch(/mirror/i);
    expect(strip()).toBe(label);
  });

  it("a background refetch does not hide a stale verdict", () => {
    setResponse(makeResponse({ quality: "stale", stale: true, isLive: false, aiUsable: false }), { isFetching: true });
    renderChart();
    expect(strip()).toBe("Stale");
    expect(screen.queryByTestId("arx-mirror-stale")).not.toBeNull();
  });

  it("a background refetch does not hide an integrity failure", () => {
    setResponse(makeResponse({ quality: "invalid", isLive: false, aiUsable: false }), { isFetching: true });
    renderChart();
    expect(screen.queryByTestId("arx-mirror-conflict")).not.toBeNull();
  });

  it("an unavailable feed is not described as syncing or waiting", () => {
    setResponse(emptyResponse({ quality: "unavailable", source: null, warning: "No live feed is available for this symbol right now." }));
    renderChart();
    const layer = screen.getByTestId("arx-mirror-layer").textContent ?? "";
    expect(layer).not.toMatch(/syncing|waiting for data/i);
    expect(strip()).toBe("Unavailable");
  });

  it("a clean feed the shared truth has not confirmed reads the same as the chip", () => {
    truthLevel = "historical_only";
    renderChart();
    expect(strip()).toBe("Unconfirmed");
  });

  it("offers no lock toggle or inspection mode that changes nothing", () => {
    renderChart();
    expect(screen.queryByTestId("arx-mirror-lock")).toBeNull();
    expect(screen.queryByTestId("arx-mirror-inspection")).toBeNull();
    expect(screen.getByTestId("arx-mirror-layer").textContent).not.toMatch(/mirror|lock/i);
  });
});

describe("a failed candle refresh withdraws every live claim", () => {
  it("drops the live price line, the AI marker and the clean strip, and says the refresh failed", () => {
    const onChartContextChange = vi.fn();
    const view = renderChart({ onChartContextChange });
    expect(adapterSpies.setFeedState.mock.calls.at(-1)?.[0]).toMatchObject({ livePriceAffordance: true });
    expect(screen.getByTestId("arx-mirror-status").textContent).toBe("Clean");

    // React Query keeps the last good data while the refetch errors.
    setResponse(candleQuery.data, { isError: true });
    view.rerender(
      <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus overlays={NO_OVERLAYS} onChartContextChange={onChartContextChange} />,
    );

    expect(adapterSpies.setFeedState.mock.calls.at(-1)?.[0]).toMatchObject({ livePriceAffordance: false });
    expect(screen.getByTestId("arx-mirror-status").textContent).toBe("Refresh failed");
    expect(screen.getByTestId("arx-feed-badge").getAttribute("data-ai-usable")).toBe("false");
    expect(screen.getByTestId("arx-feed-badge").getAttribute("data-severity")).not.toBe("clean");
    expect(screen.getByTestId("arx-native-refresh-failed").textContent).toMatch(/refresh failed/i);
    expect((onChartContextChange.mock.calls.at(-1)?.[0] as { aiUsable: boolean }).aiUsable).toBe(false);
  });
});

describe("an unavailable feed's empty state repeats what the server said", () => {
  const SERVER = "No live feed is available for this symbol right now. Try a different symbol.";

  it("shows the server warning, not optimistic syncing copy", () => {
    setResponse(emptyResponse({ quality: "unavailable", source: null, warning: SERVER }));
    renderChart();
    const empty = screen.getByTestId("arx-native-empty").textContent ?? "";
    expect(empty).toContain(SERVER);
    expect(empty).not.toMatch(/syncing|waiting for a live feed/i);
  });

  it("names the symbol and timeframe plainly when the server gave no message", () => {
    setResponse(emptyResponse({ quality: "unavailable", source: null, warning: null }));
    renderChart();
    const empty = screen.getByTestId("arx-native-empty").textContent ?? "";
    expect(empty).not.toMatch(/syncing|waiting for a live feed/i);
    expect(empty).toContain(`${SYMBOL} on ${TF}`);
  });
});

describe("the header chip and its cap describe the same candle window", () => {
  it("resolves the cap over the chart's own limit and poll cadence", () => {
    renderChart();
    const last = scannerTruthCalls.at(-1)!;
    expect(last[0]).toBe(SYMBOL);
    expect(last[1]).toBe("5m");
    expect(last[2]).toEqual({ limit: 300, refetchInterval: 8000 });
  });

  it("follows a custom chart limit", () => {
    renderChart({ limit: 500 });
    expect(scannerTruthCalls.at(-1)![2]).toEqual({ limit: 500, refetchInterval: 8000 });
  });
});

describe("the frozen-quote chip follows the server's closed-market semantics", () => {
  const CHIP = "arx-native-market-closed";
  function emitFrozen() {
    act(() => {
      openedSources[0]!.onmessage?.({
        data: JSON.stringify({
          type: "feed_status", source: "mt5_broker", symbol: SYMBOL, timeframe: TF,
          marketFrozen: true, lastBrokerTimeMs: Date.UTC(2026, 9, 28, 9, 30), ts: Date.now(),
        }),
      });
    });
  }

  it("a frozen quote on a weekday reads 'Quote not moving', never 'Market closed'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 28, 12, 0)); // Wednesday
    renderChart();
    emitFrozen();
    const chip = screen.getByTestId(CHIP);
    expect(chip.textContent).toMatch(/Quote not moving — last quote Wed 09:30 UTC/);
    expect(chip.textContent).not.toMatch(/market closed/i);
    expect(chip.getAttribute("title") ?? "").not.toMatch(/the market is closed/i);
  });

  it("inside the scheduled weekend close the same signal reads 'Market closed'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0)); // Saturday
    renderChart();
    emitFrozen();
    expect(screen.getByTestId(CHIP).textContent).toMatch(/Market closed — last quote/);
  });

  it("a 24/7 market is never called closed by a frozen quote", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0)); // Saturday
    setResponse(makeResponse({ assetClass: "crypto" } as Partial<ChartFeedStatus>));
    renderChart();
    emitFrozen();
    expect(screen.getByTestId(CHIP).textContent).toMatch(/Quote not moving/);
  });
});

describe("one instrument precision on the native chart's axis, header and side panels", () => {
  function withServerPrecision(p: number | null): ChartCandlesResponse {
    return { ...makeResponse(), truthResult: { pricePrecision: p } } as unknown as ChartCandlesResponse;
  }

  it("resolves the shared precision (server-declared, widened by observed digits) for the header and the axis", () => {
    setResponse(withServerPrecision(4));
    renderChart();
    expect(screen.getByTestId("arx-native-last").textContent).toMatch(/1\.1020$/);
    expect(adapterSpies.setDisplayPricePrecision).toHaveBeenLastCalledWith(4);
  });

  it("with no server precision the quotes' own digits decide, not a fiat-pair guess", () => {
    setResponse(withServerPrecision(null));
    renderChart();
    expect(screen.getByTestId("arx-native-last").textContent).toMatch(/1\.102$/);
    expect(adapterSpies.setDisplayPricePrecision).toHaveBeenLastCalledWith(3);
  });

  it("publishes the precision for the side panels of the same symbol and withdraws it on unmount", async () => {
    const { readChartPricePrecision } = await import("./chartPricePrecisionStore");
    setResponse(withServerPrecision(4));
    const view = renderChart();
    expect(readChartPricePrecision(SYMBOL)).toBe(4);
    view.unmount();
    expect(readChartPricePrecision(SYMBOL)).toBeNull();
  });
});

describe("the header price is last-known while the broker repeats a frozen quote", () => {
  it("prefixes 'Last known' after a frozen-quote verdict on a live-graded feed", () => {
    renderChart();
    expect(screen.getByTestId("arx-native-last").textContent).not.toMatch(/last known/i);
    act(() => {
      openedSources[0]!.onmessage?.({
        data: JSON.stringify({ type: "feed_status", source: "mt5_broker", symbol: SYMBOL, timeframe: TF,
          marketFrozen: true, lastBrokerTimeMs: NEWEST_OPEN_MS, ts: Date.now() }),
      });
    });
    const badge = screen.getByTestId("arx-native-last");
    expect(badge.textContent).toMatch(/^Last known /);
    expect(badge.getAttribute("title") ?? "").toMatch(/same quote/i);
  });
});

// The mirror strip's stale chip read "Feed is stale" for every stale grade.
// Inside a scheduled weekend close with no bar since the close, the server's
// own feed warning says "Market closed … Not a feed fault"; for a market with
// session closes outside that window it says the market may be closed or the
// feed delayed. Only a 24/7 market's stale grade is a stale feed.
describe("the stale chip names the cause the evidence supports", () => {
  const staleChip = () => screen.getByTestId("arx-mirror-stale").textContent ?? "";
  function staleResponse(newestOpenMs: number, assetClass = "forex"): ChartCandlesResponse {
    const base = makeResponse({ quality: "stale", stale: true, isLive: false, aiUsable: false, assetClass } as Partial<ChartFeedStatus>);
    return {
      ...base,
      candles: [
        makeCandle(newestOpenMs - 2 * M5_MS, 1.1, "mt5_broker"),
        makeCandle(newestOpenMs - M5_MS, 1.101, "mt5_broker"),
        makeCandle(newestOpenMs, 1.102, "mt5_broker"),
      ],
    } as unknown as ChartCandlesResponse;
  }

  it("inside the weekend close with no bar since the close it says market closed, not a stale feed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0)); // Saturday
    setResponse(staleResponse(Date.UTC(2026, 9, 30, 21, 55))); // Fri 21:55, before the 22:00 close
    renderChart();
    expect(staleChip()).toMatch(/market closed/i);
    expect(staleChip()).toMatch(/not a feed fault/i);
    expect(staleChip()).not.toMatch(/feed is stale/i);
  });

  it("a session market outside the weekend close says it may be closed or delayed, not 'Feed is stale'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 28, 12, 0)); // Wednesday
    setResponse(staleResponse(Date.UTC(2026, 9, 28, 9, 0)));
    renderChart();
    expect(staleChip()).not.toMatch(/feed is stale/i);
    expect(staleChip()).toMatch(/may be closed or the feed delayed/i);
  });

  it("a bar after the weekend close is not a closed market", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0)); // Saturday
    setResponse(staleResponse(Date.UTC(2026, 9, 31, 10, 0)));
    renderChart();
    expect(staleChip()).not.toMatch(/market closed/i);
  });

  it("a 24/7 market's stale grade is a stale feed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 0)); // Saturday
    setResponse(staleResponse(Date.UTC(2026, 9, 30, 21, 55), "crypto"));
    renderChart();
    expect(staleChip()).toBe("Feed is stale");
  });
});
