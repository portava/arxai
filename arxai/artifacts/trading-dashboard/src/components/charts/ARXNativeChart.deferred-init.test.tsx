import { requestChartResearch } from "@/lib/chart-research/chartResearchAssistant";
import { runCausalResearchV2 } from "@workspace/domain/backtest/research";
const researchRunner=vi.hoisted(()=>({run:vi.fn(),cancel:vi.fn()}));
vi.mock("@/lib/chart-research/researchRunner",()=>({createBrowserResearchRunner:()=>researchRunner}));
import {AssistantDockProvider} from "@/components/help/AssistantDock";
import { requestChartStudy } from "@/lib/chart-engine/chartStudyAssistant";
// P2 — comparison chart cards mount in the click commit, but each new
// comparison's chart engine (lightweight-charts init + its own first paint)
// is built only after the mounting frame has painted: one animation frame,
// then a macrotask, one comparison per frame. The primary chart is untouched.
// Until its engine exists a comparison's chart context is bound without one, so
// its tick stream's feed_status and liveness keep their effect and its newest
// forming tip is applied once the engine holds the context's candles.

import { Component, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen, fireEvent, within } from "@testing-library/react";

type Spy = ReturnType<typeof vi.fn>;
type FakeAdapter = Record<string, Spy> & { id: number };
const created: FakeAdapter[] = [];
const calls: string[] = [];
// The next engine setup step to throw (once): the factory itself, or one adapter call.
let setupFailure: { at: string; error: Error } | null = null;
function failIfDue(at: string) {
  if (setupFailure?.at !== at) return;
  const { error } = setupFailure;
  setupFailure = null;
  throw error;
}

function makeAdapter(): FakeAdapter {
  const id = created.length + 1;
  const track = (name: string) => vi.fn(() => { calls.push(`${id}:${name}`); failIfDue(name); return undefined; });
  const adapter = {
    id,
    init: track("init"),
    destroy: track("destroy"),
    setSymbol: track("setSymbol"),
    setTimeframe: track("setTimeframe"),
    setCrosshairHandler: track("setCrosshairHandler"),
    setViewLinkStatusHandler: track("setViewLinkStatusHandler"),
    setViewLinkHandler: track("setViewLinkHandler"),
    resetDataContext: track("resetDataContext"),
    setFeedState: track("setFeedState"),
    setCandles: track("setCandles"),
    setOverlays: track("setOverlays"),
    setStudies: track("setStudies"),
    setChartStyle: track("setChartStyle"),
    setScaleMode: track("setScaleMode"),
    resize: track("resize"),
    setReachStartHandler: track("setReachStartHandler"),
    updateActiveCandle: track("updateActiveCandle"),
    setLinkedTimeRange: track("setLinkedTimeRange"),
    setLinkedCrosshair: track("setLinkedCrosshair"),
    setDisplayTimeZone: track("setDisplayTimeZone"),
    priceToCoordinate: vi.fn(() => null),
  } as unknown as FakeAdapter;
  created.push(adapter);
  return adapter;
}

vi.mock("@/lib/chart-engine", () => ({ createChartEngineAdapter: () => { failIfDue("create"); return makeAdapter(); } }));

vi.mock("@/lib/useChartDeepHistory", () => ({
  useChartDeepHistory: () => ({
    olderCandles: [], loading: false, hasMore: false, providerCapped: false, limitationReason: null,
    coverageDays: 0, depthTargetDays: 0, loadedAny: false, loadOlder: vi.fn(), reset: vi.fn(),
  }),
}));

let candleResponse: unknown;
let intelligenceResponse: unknown;
const truthSymbols: string[] = [];
const candleRequests: {timeframe:string;enabled:boolean}[]=[];
vi.mock("@workspace/api-client-react", () => ({
  useGetChartCandles: (params:{timeframe:string},options:{query:{enabled:boolean}}) => {candleRequests.push({timeframe:params.timeframe,enabled:options.query.enabled});return { data: candleResponse, isLoading: false, isError: false, isFetching: false };},
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: intelligenceResponse, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (symbol:string) => {truthSymbols.push(symbol);return { truth: null, feedStatus: null, isLoading: false, isError: false, refetch: () => {} };},
}));

vi.mock("@/components/scanner/SymbolExplorer", () => ({ SymbolExplorer: () => null }));

import { ARXNativeChart } from "./ARXNativeChart";
import { SmartChartLayout } from "./SmartChartLayout";
import { CHART_INTERVALS, CHART_QUICK_INTERVALS } from "@/lib/chart-engine/chartIntervals";
import { CHART_LAYOUT_KEY } from "@/lib/chart-engine/chartLayout";

let frames: FrameRequestCallback[] = [];
let streams: { url: string; onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null; closed: boolean }[] = [];
let documentHidden = false;
const OPEN_MS = 1_700_000_000_000;
function liveResponse(symbol: string, timeframe: string) {
  const candle = (openMs: number, close: number) => ({ timeBasisEvidence: {kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null}, symbol, displaySymbol: symbol, timeframe, openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + 3_600_000).toISOString(), open: close, high: close + 0.001, low: close - 0.001, close, source: "mt5_broker", isComplete: true });
  return { symbol, timeframe, candles: [candle(OPEN_MS - 3_600_000, 1.1), candle(OPEN_MS, 1.101)],
    feedStatus: { symbol, source: "mt5_broker", isLive: true, stale: false, quality: "clean", aiUsable: true, warning: null }, warning: null };
}

/** Run the animation-frame callbacks queued so far (one browser frame). */
function runFrame() {
  const due = frames;
  frames = [];
  act(() => { for (const callback of due) callback(performance.now()); });
}
/** Run the macrotasks queued so far (the post-paint task). */
function runTasks() {
  act(() => { vi.runOnlyPendingTimers(); });
}
const inits = () => calls.filter(call => call.endsWith(":init"));
const NO_OVERLAYS: never[] = [];
const formingBar = (close: number, openMs = OPEN_MS) => ({ data: JSON.stringify({ type: "forming_bar", source: "mt5_broker", symbol: "EURUSD", timeframe: "H1", frozen: false,
  bar: { openTimeMs: openMs, open: 1.101, high: 1.103, low: 1.1, close } }) });
const feedStatus = (marketFrozen: boolean) => ({ data: JSON.stringify({ type: "feed_status", source: "mt5_broker", symbol: "EURUSD", timeframe: "H1",
  marketFrozen, lastBrokerTimeMs: OPEN_MS }) });
const heartbeat = { data: JSON.stringify({ type: "heartbeat" }) };
class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error ? <p data-testid={`boundary-${this.props.name}`}>{this.state.error.message}</p> : this.props.children;
  }
}
function setDocumentHidden(hidden: boolean, notify = true) {
  documentHidden = hidden;
  if (notify) act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => {
  created.length = 0;
  calls.length = 0;
  setupFailure = null;
  frames = [];
  streams = [];
  candleResponse = undefined;
  intelligenceResponse = undefined;
  candleRequests.length = 0;
  truthSymbols.length = 0;
  localStorage.clear();
  documentHidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => documentHidden });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("EventSource", class {
    entry: (typeof streams)[number];
    constructor(url: string) { this.entry = { url, onmessage: null, onerror: null, closed: false }; streams.push(this.entry); }
    set onmessage(handler: ((event: { data: string }) => void) | null) { this.entry.onmessage = handler; }
    get onmessage() { return this.entry.onmessage; }
    set onerror(handler: (() => void) | null) { this.entry.onerror = handler; }
    get onerror() { return this.entry.onerror; }
    close() { this.entry.closed = true; }
  });
});

afterEach(() => {
  cleanup();
  // Drain anything still queued so the module-level stagger queue starts clean.
  for (let i = 0; i < 10 && (frames.length || vi.getTimerCount()); i++) { runFrame(); runTasks(); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

describe("initial responsive chart height", () => {
  it.each([
    {width:390,height:520,mobileHeight:360,expected:360},
    {width:767,height:520,mobileHeight:360,expected:360},
    {width:768,height:520,mobileHeight:360,expected:520},
    {width:390,height:280,mobileHeight:undefined,expected:320},
    {width:390,height:520,mobileHeight:undefined,expected:380},
    {width:1100,height:320,viewportHeight:700,mobileHeight:undefined,compactWorkspace:true,expected:390},
    {width:1280,height:320,viewportHeight:720,mobileHeight:undefined,compactWorkspace:true,expected:390},
    {width:1440,height:320,viewportHeight:900,mobileHeight:undefined,compactWorkspace:true,expected:390},
    {width:1440,height:1500,viewportHeight:900,mobileHeight:undefined,compactWorkspace:true,expected:585},
    {width:1920,height:520,viewportHeight:1080,mobileHeight:undefined,compactWorkspace:true,expected:520},
    {width:1440,height:640,mobileHeight:undefined,expected:640},
  ])("initializes cached candles at $expected px for width $width and viewport height $viewportHeight", ({width,height,viewportHeight=height,mobileHeight,compactWorkspace=false,expected}) => {
    vi.stubGlobal("innerWidth",width);
    vi.stubGlobal("innerHeight",viewportHeight);
    candleResponse=liveResponse("EURUSD","H1");
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" height={height} mobileHeight={mobileHeight} compactWorkspace={compactWorkspace} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(created).toHaveLength(1);
    const engine=created[0]!;
    expect(engine.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({height:expected}));
    expect(screen.getByTestId("arx-native-canvas").style.height).toBe(`${expected}px`);
    expect(engine.resize.mock.calls.every(call=>call[1]===expected)).toBe(true);
    expect(engine.setCandles).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({time:OPEN_MS/1000,close:1.101})]));
    expect(engine.destroy).not.toHaveBeenCalled();
  });

  it("retains the engine and candles through prop, breakpoint and fullscreen height changes", () => {
    vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);
    candleResponse=liveResponse("EURUSD","H1");
    const app=(height:number,mobileHeight:number)=><ARXNativeChart symbol="EURUSD" timeframe="H1" height={height} mobileHeight={mobileHeight} showFeedStatus={false} overlays={NO_OVERLAYS}/>;
    const view=render(app(520,360)),engine=created[0]!,canvas=screen.getByTestId("arx-native-canvas");
    const assertHeight=(expected:number)=>{
      expect(canvas.style.height).toBe(`${expected}px`);
      expect(engine.resize).toHaveBeenLastCalledWith(undefined,expected);
      expect(created).toHaveLength(1);expect(engine.init).toHaveBeenCalledTimes(1);
      expect(engine.destroy).not.toHaveBeenCalled();expect(screen.getByTestId("arx-native-canvas")).toBe(canvas);
      expect(engine.setCandles).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({time:OPEN_MS/1000,close:1.101})]));
    };
    assertHeight(360);view.rerender(app(700,420));assertHeight(420);
    vi.stubGlobal("innerWidth",768);act(()=>window.dispatchEvent(new Event("resize")));assertHeight(700);
    vi.stubGlobal("innerHeight",400);fireEvent.click(screen.getByRole("button",{name:"Fullscreen",exact:true}));assertHeight(240);
    vi.stubGlobal("innerHeight",800);act(()=>window.dispatchEvent(new Event("resize")));assertHeight(560);
    fireEvent.click(screen.getByRole("button",{name:"Exit fullscreen",exact:true}));assertHeight(700);
    vi.stubGlobal("innerWidth",390);act(()=>window.dispatchEvent(new Event("resize")));assertHeight(420);
  });

  it("uses the latest viewport when a deferred comparison engine starts",()=>{
    vi.stubGlobal("innerWidth",390);candleResponse=liveResponse("EURUSD","H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" height={520} mobileHeight={360} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(created).toHaveLength(0);expect(screen.getByTestId("arx-native-canvas").style.height).toBe("360px");
    vi.stubGlobal("innerWidth",1440);act(()=>window.dispatchEvent(new Event("resize")));
    runFrame();runTasks();
    expect(created).toHaveLength(1);expect(created[0]!.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({height:520}));
    expect(screen.getByTestId("arx-native-canvas").style.height).toBe("520px");
  });
});

describe("source-bound stream warning", () => {
  const responseFor = (source:string) => {
    const response=liveResponse("EURUSD","H1");
    return {...response,candles:response.candles.map(c=>({...c,source})),feedStatus:{...response.feedStatus,source}};
  };
  const clock = () => {vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","Date"]});};
  it.each(["offline_fixture","twelve_data"])("never reconnects nonexistent %s streams after multiple silence windows", source => {
    clock();candleResponse=responseFor(source);const interval=vi.spyOn(globalThis,"setInterval");
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    act(()=>vi.advanceTimersByTime(95_000));
    const scheduled=interval.mock.calls.length;interval.mockRestore();
    expect(streams).toHaveLength(0);expect(scheduled).toBe(0);
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
  });
  it("removes a stalled MT5 warning on nonstream replacement and gives a returning MT5 source a full deadline", () => {
    clock();candleResponse=responseFor("mt5_broker");
    const chart=<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>;const view=render(chart);
    act(()=>streams[0]!.onerror!());expect(screen.getByTestId("arx-native-stream-reconnecting")).toBeTruthy();
    candleResponse=responseFor("offline_fixture");view.rerender(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    expect(streams[0]!.closed).toBe(true);expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    act(()=>{streams[0]!.onerror!();streams[0]!.onmessage!(heartbeat);});
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    act(()=>vi.advanceTimersByTime(95_000));expect(streams).toHaveLength(1);expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    candleResponse=responseFor("mt5_broker");view.rerender(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    expect(streams).toHaveLength(2);act(()=>vi.advanceTimersByTime(29_999));expect(streams).toHaveLength(2);
    // Late frames/errors from the first MT5 connection cannot contaminate or
    // postpone this new MT5 connection, even though their source key is equal.
    act(()=>{streams[0]!.onerror!();streams[0]!.onmessage!(heartbeat);});
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    act(()=>vi.advanceTimersByTime(1));expect(streams).toHaveLength(3);expect(streams[1]!.closed).toBe(true);
  });
  it("does not invent retries when EventSource is unsupported", () => {
    clock();candleResponse=responseFor("mt5_broker");vi.stubGlobal("EventSource",undefined);
    const interval=vi.spyOn(globalThis,"setInterval");render(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    act(()=>vi.advanceTimersByTime(95_000));
    const scheduled=interval.mock.calls.length;interval.mockRestore();
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();expect(scheduled).toBe(0);
  });
  it("retries a transient constructor failure on the bounded deadline and then recovers", () => {
    clock();candleResponse=responseFor("mt5_broker");const WorkingEventSource=globalThis.EventSource;let attempts=0;
    vi.stubGlobal("EventSource",class extends WorkingEventSource {constructor(url:string){attempts++;if(attempts===1)throw Error("Transient construction failure");super(url);}});
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    expect(attempts).toBe(1);expect(streams).toHaveLength(0);
    act(()=>vi.advanceTimersByTime(29_999));expect(attempts).toBe(1);
    act(()=>vi.advanceTimersByTime(1));expect(attempts).toBe(2);expect(streams).toHaveLength(1);
    // Constructing the replacement proves nothing about delivery: the chart
    // keeps saying it is reconnecting until a frame actually arrives.
    expect(screen.getByTestId("arx-native-stream-reconnecting")).toBeTruthy();
    act(()=>streams[0]!.onmessage!(heartbeat));
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    act(()=>vi.advanceTimersByTime(29_999));expect(attempts).toBe(2);
  });

});

describe("compact chart evidence", () => {
  it("names simultaneous restrictions before disclosure and retains their full explanations", () => {
    const response = liveResponse("EURUSD", "H1");
    candleResponse = {...response, candles: [0, 1, 2].map(index => ({...response.candles[0]!, timeBasisEvidence: undefined,
      openTime: new Date(OPEN_MS + index * 3_600_000).toISOString(),
      closeTime: new Date(OPEN_MS + (index + 1) * 3_600_000).toISOString(),
      open: 1.1, high: 1.1, low: 1.1, close: 1.1})),
      feedStatus: {...response.feedStatus, quality: "delayed", aiUsable: false, message: "Provider delayed with an exact source explanation"}};
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    const restrictions = screen.getByTestId("chart-evidence-restrictions");
    expect(restrictions.textContent).toContain("UTC mapping unverified");
    expect(restrictions.textContent).toContain("OHLC candles are flat");
    expect(restrictions.textContent).toContain("Not AI-confirmed");
    expect(restrictions.textContent).toContain("feed");
    expect(restrictions.closest("details")).toBeNull();
    const details = screen.getByTestId("chart-evidence-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const summary = within(details).getByText("Chart evidence details").closest("summary")!;
    summary.focus(); expect(document.activeElement).toBe(summary);
    fireEvent.click(summary); expect(details.open).toBe(true);
    expect(details.textContent).toContain("Provider delayed with an exact source explanation");
    expect(details.textContent).toContain("timezone conversion and UTC historical tests are unavailable");
    expect(details.textContent).toContain("Price action shown, no spread");
    fireEvent.click(summary); expect(details.open).toBe(false);
    expect(restrictions.textContent).toContain("Not AI-confirmed");
  });

  it("keeps reconnect and frozen-market truth visible outside the closed disclosure on the same canvas", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" overlays={NO_OVERLAYS}/>);
    const canvas = screen.getByTestId("arx-native-canvas");
    const details = screen.getByTestId("chart-evidence-details") as HTMLDetailsElement;
    act(() => streams[0]!.onerror!());
    const reconnect = screen.getByTestId("arx-native-stream-reconnecting");
    expect(reconnect.textContent).toContain("Reconnecting — prices delayed");
    expect(reconnect.closest("details")).toBeNull(); expect(details.open).toBe(false);
    act(() => streams[0]!.onmessage!(feedStatus(true)));
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    expect(screen.getByTestId("arx-native-market-closed").closest("details")).toBeNull();
    act(() => streams[0]!.onmessage!(feedStatus(false)));
    expect(screen.queryByTestId("arx-native-market-closed")).toBeNull();
    expect(screen.getByTestId("arx-native-canvas")).toBe(canvas);
    expect(created).toHaveLength(1); expect(created[0]!.init).toHaveBeenCalledTimes(1); expect(created[0]!.destroy).not.toHaveBeenCalled();
  });

  it("keeps mandatory integrity and clock warnings with optional feed badges off, without replacing the engine", () => {
    const response = liveResponse("EURUSD", "H1");
    candleResponse = {...response, candles: response.candles.map(c => ({...c, timeBasisEvidence: undefined})),
      warning: "Original provider integrity reason", feedStatus: {...response.feedStatus, quality: "invalid", aiUsable: false}};
    const view = render(<ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    const restrictions = screen.getByTestId("chart-evidence-restrictions"), canvas = screen.getByTestId("arx-native-canvas");
    expect(restrictions.textContent).toContain("Data validation failed — AI analysis paused");
    expect(restrictions.textContent).toContain("UTC mapping unverified");
    const details = screen.getByTestId("chart-evidence-details") as HTMLDetailsElement;
    const summary = within(details).getByText("Chart evidence details").closest("summary")!;
    fireEvent.click(summary);
    expect(details.textContent).toContain("Original provider integrity reason");
    // The Mirror Lock toggle and its "inspection mode" notice were removed (it
    // implied a lock the chart does not enforce); neither may come back.
    expect(screen.queryByTestId("arx-mirror-lock")).toBeNull();
    expect(screen.queryByTestId("chart-evidence-inspection")).toBeNull();
    fireEvent.click(summary);
    vi.stubGlobal("innerWidth",320);act(()=>window.dispatchEvent(new Event("resize")));
    expect(screen.getByTestId("arx-native-canvas")).toBe(canvas);
    expect(created).toHaveLength(1);expect(created[0]!.init).toHaveBeenCalledTimes(1);expect(created[0]!.destroy).not.toHaveBeenCalled();
    view.rerender(<ARXNativeChart symbol="GBPUSD" timeframe="H1" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(screen.queryByText("Original provider integrity reason")).toBeNull();
    expect(screen.queryByTestId("chart-evidence-restrictions")).toBeNull();
  });
});

describe("persistent chart notices do not cover candles or user notes", () => {
  const noticeIds = ["arx-native-safe-mode", "arx-native-line-mode", "arx-native-feed-banner"];
  const assertNoticeBeforeCanvas = (id: string) => {
    const notice = screen.getByTestId(id), canvas = screen.getByTestId("arx-native-canvas"), layer = canvas.parentElement!;
    expect(notice.classList.contains("absolute")).toBe(false);
    expect(notice.classList.contains("fixed")).toBe(false);
    expect(layer.contains(notice)).toBe(false);
    expect(notice.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The canvas and projected overlays keep the same relative origin; adding
    // a warning inside this container would shift one without the other.
    expect(layer.classList.contains("relative")).toBe(true);
    expect(layer.firstElementChild).toBe(canvas);
    expect(screen.getByTestId("test-coordinate-overlay").parentElement).toBe(layer);
    expect(canvas.style.height).toBe("520px");
  };
  const chart = (showFeedStatus = true) => <ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={showFeedStatus}
    overlays={NO_OVERLAYS} canvasOverlay={<div data-testid="test-coordinate-overlay" className="absolute inset-0" />} />;
  it("keeps the invalid-data warning before the canvas while preserving its text and source", () => {
    const response = liveResponse("EURUSD", "H1");
    candleResponse = {...response, warning: "Provider integrity failed", feedStatus: {...response.feedStatus, quality: "invalid", aiUsable: false}};
    const {rerender} = render(chart(false));
    assertNoticeBeforeCanvas("arx-native-safe-mode");
    expect(screen.getByTestId("arx-native-safe-mode").textContent).toContain("Provider integrity failed");
    expect(screen.getByTestId("arx-native-safe-mode").classList.contains("bg-red-950/80")).toBe(true);
    expect(screen.queryByTestId("arx-native-line-mode")).toBeNull();
    expect(screen.queryByTestId("arx-native-feed-banner")).toBeNull();
    expect(created[0]!.setCandles).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({close: 1.101})]));
    created[0]!.priceToCoordinate.mockReturnValue(42);
    const position: NonNullable<Parameters<typeof ARXNativeChart>[0]["overlays"]> = [
      {id: "open-position", type: "line", symbol: "EURUSD", timeframe: "H1", price: 1.1, label: "Position", source: "position", metadata: {pnl: 12, side: "BUY"}},
    ];
    rerender(<ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={false} overlays={position}
      canvasOverlay={<div data-testid="test-coordinate-overlay" className="absolute inset-0" />} />);
    expect(screen.getByTestId("arx-native-pnl-layer").parentElement).toBe(screen.getByTestId("arx-native-canvas").parentElement);
    expect(screen.getByTestId("arx-native-pnl-bubble").style.top).toBe("42px");
    expect(screen.getByTestId("arx-native-pnl-bubble").textContent).toContain("+12.00");
    assertNoticeBeforeCanvas("arx-native-safe-mode");
  });
  it("stacks flat-OHLC and degraded-feed notices before the shared coordinate container", () => {
    const response = liveResponse("EURUSD", "H1"), candle = response.candles[0]!;
    candleResponse = {...response, candles: [0, 1, 2].map(index => ({...candle,
      openTime: new Date(OPEN_MS + index * 3_600_000).toISOString(), closeTime: new Date(OPEN_MS + (index + 1) * 3_600_000).toISOString(),
      open: 1.1, high: 1.1, low: 1.1, close: 1.1})),
      feedStatus: {...response.feedStatus, quality: "delayed", aiUsable: false, message: "Provider is delayed"}};
    render(chart());
    assertNoticeBeforeCanvas("arx-native-line-mode");assertNoticeBeforeCanvas("arx-native-feed-banner");
    expect(screen.getByTestId("arx-native-line-mode").textContent).toContain("OHLC candles are flat");
    expect(screen.getByTestId("arx-native-feed-banner").textContent).toContain("Provider is delayed");
    expect(screen.getByTestId("arx-native-feed-banner").getAttribute("data-severity")).toBe("caution");
    expect(screen.getByTestId("arx-native-line-mode").parentElement).toBe(screen.getByTestId("arx-native-feed-banner").parentElement);
  });
  it.each(["symbol", "timeframe", "source"])("withholds stale %s warning data and coordinate overlays when the candle response does not match", field => {
    const response = liveResponse("EURUSD", "H1");
    candleResponse = {...response, feedStatus: {...response.feedStatus, quality: "invalid", aiUsable: false},
      ...(field === "symbol" ? {symbol: "GBPUSD"} : field === "timeframe" ? {timeframe: "M5"} : {candles: response.candles.map(c => ({...c, source: "other"}))})};
    render(chart());
    for (const id of noticeIds) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByTestId("test-coordinate-overlay")).toBeNull();
    expect(screen.getByTestId("arx-native-empty")).toBeTruthy();
    expect(created[0]!.setCandles.mock.calls.every(([bars]) => bars.length === 0)).toBe(true);
  });
});

describe("deferred comparison engine init", () => {
  it.each(CHART_INTERVALS)("restores saved %s without falling back and keeps the engine's interval", timeframe => {
    localStorage.setItem("arx.nativeChart.timeframe",timeframe);
    render(<ARXNativeChart symbol="EURUSD" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(screen.getByRole("region",{name:new RegExp(`EURUSD ${timeframe} price chart`)})).toBeTruthy();
    expect(created[0]!.setTimeframe).toHaveBeenLastCalledWith(timeframe);
    expect(candleRequests.at(-1)).toEqual({timeframe,enabled:true});
    if ((CHART_QUICK_INTERVALS as readonly string[]).includes(timeframe)) {
      expect(screen.getByRole("button",{name:`${timeframe} timeframe`,exact:true}).getAttribute("aria-pressed")).toBe("true");
    } else expect((screen.getByLabelText("More chart intervals") as HTMLSelectElement).value).toBe(timeframe);
  });
  it("selects additional intervals without remounting canvas, saves them and leaves source-dependent calendar intervals unavailable", () => {
    render(<ARXNativeChart symbol="EURUSD" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    const canvas=screen.getByTestId("arx-native-canvas"), select=screen.getByLabelText("More chart intervals") as HTMLSelectElement;
    for (const timeframe of CHART_INTERVALS.filter(tf=>!(CHART_QUICK_INTERVALS as readonly string[]).includes(tf))) {
      fireEvent.change(select,{target:{value:timeframe}});
      expect(created[0]!.setTimeframe).toHaveBeenLastCalledWith(timeframe);
      expect(candleRequests.at(-1)).toEqual({timeframe,enabled:true});
      expect(localStorage.getItem("arx.nativeChart.timeframe")).toBe(timeframe);
      expect(screen.getByTestId("arx-native-canvas")).toBe(canvas);
    }
    expect([...select.options].find(option=>option.value==="MN1")?.disabled).toBe(true);
    fireEvent.change(select,{target:{value:"MN1"}});
    expect(localStorage.getItem("arx.nativeChart.timeframe")).toBe("H12");
    expect(inits()).toHaveLength(1);
  });
  it.each(["W1", "MN1"] as const)("withholds requested %s responses, cached intelligence and Truth queries", timeframe => {
    candleResponse=liveResponse("EURUSD",timeframe);
    intelligenceResponse={state:{symbol:"EURUSD",timeframe}};
    const onIntelligenceChange=vi.fn();
    render(<ARXNativeChart symbol="EURUSD" timeframe={timeframe} showFeedStatus={false} overlays={NO_OVERLAYS} onIntelligenceChange={onIntelligenceChange}/>);
    expect(screen.getByText(/charts are unavailable until source-verified/)).toBeTruthy();
    expect(created[0]!.setCandles.mock.calls.every(([bars])=>bars.length===0)).toBe(true);
    expect(candleRequests.at(-1)).toEqual({timeframe,enabled:false});
    expect(truthSymbols.every(symbol=>symbol==="")).toBe(true);
    expect(streams).toHaveLength(0);
    expect(onIntelligenceChange).not.toHaveBeenCalled();
  });
  it.each(["W1", "MN1"] as const)("keeps saved native %s visible with its refusal", timeframe => {
    localStorage.setItem("arx.nativeChart.timeframe",timeframe);
    render(<ARXNativeChart symbol="EURUSD" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(screen.getByRole("region",{name:new RegExp(`EURUSD ${timeframe} price chart`)})).toBeTruthy();
    expect(screen.getByText(/charts are unavailable until source-verified/)).toBeTruthy();
    expect(candleRequests.at(-1)).toEqual({timeframe,enabled:false});
    expect(localStorage.getItem("arx.nativeChart.timeframe")).toBe(timeframe);
  });
  it.each(["W1", "MN1"] as const)("keeps saved comparison %s visible with its refusal", timeframe => {
    localStorage.setItem(CHART_LAYOUT_KEY,JSON.stringify({count:2,comparisons:[{timeframe}]}));
    render(<SmartChartLayout symbol="EURUSD"><p>Primary placeholder</p></SmartChartLayout>);
    expect(screen.getByRole("region",{name:new RegExp(`EURUSD ${timeframe} price chart`)})).toBeTruthy();
    expect(screen.getByText(/charts are unavailable until source-verified/)).toBeTruthy();
    expect(candleRequests.at(-1)).toEqual({timeframe,enabled:false});
    expect(JSON.parse(localStorage.getItem(CHART_LAYOUT_KEY)!).comparisons[0].timeframe).toBe(timeframe);
  });
  it("builds the primary engine in the mounting commit", () => {
    render(<ARXNativeChart symbol="EURUSD" timeframe="M5" showFeedStatus={false} overlays={NO_OVERLAYS} />);
    expect(inits()).toEqual(["1:init"]);
    expect(calls).toContain("1:resetDataContext");
  });

  it("mounts the comparison card synchronously and builds its engine after the painted frame", () => {
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" height={520} showFeedStatus overlays={NO_OVERLAYS} />);
    expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(1);
    const canvas = screen.getByTestId("arx-native-canvas");
    expect(canvas.style.height).toBe("520px");
    expect(screen.getByRole("region", { name: /EURUSD H1 price chart/ })).toBe(canvas);
    expect(created).toHaveLength(0);

    // A rAF alone is still inside the mounting frame, before its paint.
    runFrame();
    expect(created).toHaveLength(0);

    runTasks();
    expect(inits()).toEqual(["1:init"]);
    // The late engine receives the same context reset and state the
    // synchronous path applies, in the same order.
    const order = calls.map(call => call.slice(2));
    expect(order.slice(0, 5)).toEqual(["init", "setSymbol", "setTimeframe", "setCrosshairHandler", "setViewLinkStatusHandler"]);
    expect(order.indexOf("resetDataContext")).toBeGreaterThan(order.indexOf("init"));
    expect(order).toEqual(expect.arrayContaining(["setStudies", "setChartStyle", "setScaleMode", "resize", "setCandles", "setOverlays", "setReachStartHandler"]));
    expect(created[0]!.init).toHaveBeenCalledWith(expect.objectContaining({ container: canvas, height: 520 }));
  });

  it("gives the deferred comparison engine its stored Heikin Ashi style in the post-build sequence", () => {
    localStorage.setItem("arx.chart.preferences.v1:comparison", JSON.stringify({ style: "heikinAshi", scale: "linear", studies: [] }));
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(created).toHaveLength(0);
    runFrame(); runTasks();
    const engine = created[0]!;
    expect(engine.setChartStyle).toHaveBeenCalledWith("heikinAshi");
    expect(engine.setChartStyle.mock.calls.every(args => args[0] === "heikinAshi")).toBe(true);
    // Same post-build sequence as the synchronous path: after the context
    // reset, alongside the context's candles (the candle layout effect runs
    // before the passive style effect, exactly as on the primary chart).
    const order = calls.map(call => call.slice(2));
    expect(order.indexOf("setChartStyle")).toBeGreaterThan(order.lastIndexOf("resetDataContext"));
    expect(engine.setCandles.mock.calls.some(args => (args[0] as unknown[]).length > 0)).toBe(true);
  });

  it("legend shows canonical OHLC first and a labelled HA suffix only when the engine reports a display bar", () => {
    render(<ARXNativeChart symbol="EURUSD" timeframe="M15" showFeedStatus={false} overlays={NO_OVERLAYS} />);
    const engine = created[0]! as FakeAdapter & { getDisplayCandle?: Spy };
    const handler = engine.setCrosshairHandler.mock.lastCall![0] as (candle: unknown) => void;
    const bar = { time: 1_700_000_100, open: 1.1, high: 1.104, low: 1.099, close: 1.102 };
    const legend = screen.getByTestId("chart-candle-inspector");
    act(() => handler(bar));
    expect(legend.textContent).toContain("O 1.10000  H 1.10400  L 1.09900  C 1.10200");
    expect(legend.textContent).not.toContain("HA");
    engine.getDisplayCandle = vi.fn(() => ({ time: bar.time, open: 1.1005, high: 1.104, low: 1.099, close: 1.10125 }));
    act(() => handler(bar));
    expect(engine.getDisplayCandle).toHaveBeenCalledWith(bar.time);
    expect(legend.textContent).toMatch(/O 1\.10000 {2}H 1\.10400 {2}L 1\.09900 {2}C 1\.10200 {2}· {2}HA \(averaged, not tradable\) O 1\.10050 {2}H 1\.10400 {2}L 1\.09900 {2}C 1\.10125$/);
    engine.getDisplayCandle = vi.fn(() => null);
    act(() => handler(bar));
    expect(legend.textContent).not.toContain("HA");
  });

  it("keeps the comparison tick stream opening at mount and applies its live frames to the deferred engine", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(streams).toHaveLength(1);
    // Nothing to draw on yet: the newest pre-build tip is held for the engine.
    act(() => streams[0]!.onmessage!(formingBar(1.1012)));
    act(() => streams[0]!.onmessage!(formingBar(1.1015)));
    // An out-of-order (older) tip never replaces a newer held one.
    act(() => streams[0]!.onmessage!(formingBar(1.0, OPEN_MS - 3_600_000)));
    expect(created).toHaveLength(0);
    runFrame(); runTasks();
    // The same stream is kept (no reconnect) and now feeds the deferred engine.
    expect(streams).toHaveLength(1);
    expect(streams[0]!.closed).toBe(false);
    const engine = created[0]!;
    // The held tip lands once, after the engine was reset and given the
    // context's candles, exactly where a live frame would have landed.
    expect(engine.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(engine.updateActiveCandle).toHaveBeenCalledWith({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.1015 });
    const loaded = engine.setCandles.mock.calls.findLastIndex(args => (args[0] as unknown[]).length > 0);
    expect(loaded).toBeGreaterThanOrEqual(0);
    expect(engine.updateActiveCandle.mock.invocationCallOrder[0]!).toBeGreaterThan(engine.setCandles.mock.invocationCallOrder[loaded]!);
    expect(engine.updateActiveCandle.mock.invocationCallOrder[0]!).toBeGreaterThan(engine.resetDataContext.mock.invocationCallOrder.at(-1)!);
    act(() => streams[0]!.onmessage!(formingBar(1.102)));
    expect(engine.updateActiveCandle).toHaveBeenCalledTimes(2);
    expect(engine.updateActiveCandle).toHaveBeenLastCalledWith({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.102 });
    // Later renders do not replay the held tip.
    runFrame(); runTasks();
    expect(engine.updateActiveCandle).toHaveBeenCalledTimes(2);
  });

  it("keeps a closed-market feed_status received before the deferred build", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(screen.queryByTestId("arx-native-market-closed")).toBeNull();
    // The server sends this once at stream open (then only every 15 s when closed).
    act(() => streams[0]!.onmessage!(feedStatus(true)));
    expect(created).toHaveLength(0);
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    // The engine arriving for the same context is not a context change.
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    expect(streams).toHaveLength(1);
    // The verdict still follows the stream after the build.
    act(() => streams[0]!.onmessage!(feedStatus(false)));
    expect(screen.queryByTestId("arx-native-market-closed")).toBeNull();
  });

  it("keeps frames that land after the engine is built but before it is committed", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    runFrame();
    // Queued behind the build task: React has not yet committed the new engine.
    setTimeout(() => {
      expect(created).toHaveLength(1);
      streams[0]!.onmessage!(feedStatus(true));
      streams[0]!.onmessage!(formingBar(1.1017));
    }, 0);
    runTasks();
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledWith({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.1017 });
    // Held until the engine was reset into the context, not drawn and then wiped.
    expect(created[0]!.updateActiveCandle.mock.invocationCallOrder[0]!).toBeGreaterThan(created[0]!.resetDataContext.mock.invocationCallOrder.at(-1)!);
  });

  it("keeps pre-build frames when the context changes in the unbuilt phase (data arrives after mount)", () => {
    // The usual production order: the card mounts before its candles, so the
    // context (which includes the feed source) changes while still unbuilt.
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    const streamsBefore = streams.length;
    candleResponse = liveResponse("EURUSD", "H1");
    view.rerender(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(created).toHaveLength(0);
    // The feed source joined the context, so the stream was reopened for it.
    expect(streams.length).toBeGreaterThan(streamsBefore);
    const stream = streams[streams.length - 1]!;
    act(() => stream.onmessage!(feedStatus(true)));
    act(() => stream.onmessage!(formingBar(1.1019)));
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledWith({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.1019 });
  });

  it("keeps pre-build stream state across a rerender that leaves the context unchanged", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    act(() => streams[0]!.onmessage!(feedStatus(true)));
    act(() => streams[0]!.onmessage!(formingBar(1.1019)));
    // A new symbol prop that resolves to the same instrument re-runs the
    // context effect (its legend callback changes) but is not a context change.
    view.rerender(<ARXNativeChart workspaceId="comparison" symbol="FX:EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(streams).toHaveLength(1);
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledWith({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.1019 });
  });

  it("drops a held tip and the closed-market verdict when the context changes before the build", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" height={400} showFeedStatus overlays={NO_OVERLAYS} />);
    act(() => streams[0]!.onmessage!(feedStatus(true)));
    act(() => streams[0]!.onmessage!(formingBar(1.1019)));
    expect(screen.getByTestId("arx-native-market-closed")).toBeTruthy();
    candleResponse = liveResponse("EURUSD", "H4");
    view.rerender(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H4" height={480} showFeedStatus overlays={NO_OVERLAYS} />);
    // The H1 verdict does not carry over to H4.
    expect(screen.queryByTestId("arx-native-market-closed")).toBeNull();
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    // The engine is built with the inputs current at build time, not at mount.
    expect(created[0]!.init).toHaveBeenCalledWith(expect.objectContaining({ height: 480 }));
    expect(created[0]!.setTimeframe.mock.calls[0]).toEqual(["H4"]);
    // The H1 tip is never drawn on the H4 chart.
    expect(created[0]!.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("never holds or draws a frozen forming_bar received before the build", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    const frozen = { data: JSON.stringify({ type: "forming_bar", source: "mt5_broker", symbol: "EURUSD", timeframe: "H1", frozen: true,
      bar: { openTimeMs: OPEN_MS, open: 1.101, high: 1.103, low: 1.1, close: 1.2 } }) };
    act(() => streams[0]!.onmessage!(frozen));
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    expect(created[0]!.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("never draws a held tip older than the newest loaded candle", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    act(() => streams[0]!.onmessage!(formingBar(1.0, OPEN_MS - 3_600_000)));
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    expect(created[0]!.setCandles.mock.calls.some(([candles]) => (candles as unknown[]).length === 2)).toBe(true);
    expect(created[0]!.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("advances the newest-bar watermark when it applies a held tip", () => {
    const response = liveResponse("EURUSD", "H1");
    candleResponse = { ...response, candles: response.candles.slice(0, 1) };
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    act(() => streams[0]!.onmessage!(formingBar(1.1019, OPEN_MS)));
    runFrame(); runTasks();
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledTimes(1);
    // A live tip for the (older) newest loaded candle is now out of order.
    act(() => streams[0]!.onmessage!(formingBar(1.0, OPEN_MS - 3_600_000)));
    expect(created[0]!.updateActiveCandle).toHaveBeenCalledTimes(1);
  });

  it("shows the reconnecting state for a stream error before the build", () => {
    const sources: { onerror: (() => void) | null }[] = [];
    vi.stubGlobal("EventSource", class {
      onmessage = null;
      onerror: (() => void) | null = null;
      constructor() { sources.push(this); }
      close() {}
    });
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(sources).toHaveLength(1);
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    act(() => sources[0]!.onerror!());
    expect(created).toHaveLength(0);
    expect(screen.getByTestId("arx-native-stream-reconnecting")).toBeTruthy();
  });

  it("keeps a stream error that lands after the engine is built but before it is committed", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    runFrame();
    // Queued behind the build task: the engine exists, the context is still bound without it.
    setTimeout(() => {
      expect(created).toHaveLength(1);
      streams[0]!.onerror!();
    }, 0);
    runTasks();
    expect(screen.getByTestId("arx-native-stream-reconnecting")).toBeTruthy();
  });

  it("counts pre-build frames as stream liveness", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    candleResponse = liveResponse("EURUSD", "H1");
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(streams).toHaveLength(1);
    // No animation frame runs, so the engine stays unbuilt for the whole minute.
    for (let i = 0; i < 3; i++) {
      act(() => { vi.advanceTimersByTime(20_000); });
      act(() => streams[0]!.onmessage!(heartbeat));
    }
    expect(created).toHaveLength(0);
    expect(streams).toHaveLength(1);
    expect(screen.queryByTestId("arx-native-stream-reconnecting")).toBeNull();
    // Control: real silence past the watchdog window still reconnects.
    act(() => { vi.advanceTimersByTime(35_000); });
    expect(streams).toHaveLength(2);
    expect(streams[0]!.closed).toBe(true);
  });

  it("needs both the painted frame and the task after it", () => {
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    // The post-paint task alone, before any frame, initialises nothing.
    runTasks();
    expect(created).toHaveLength(0);
    runFrame();
    expect(created).toHaveLength(0);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
  });

  it("builds without an animation frame when the document is hidden at mount", () => {
    setDocumentHidden(true, false);
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    expect(frames).toHaveLength(0);
    expect(created).toHaveLength(0);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
  });

  it("does not stall when the tab is hidden while the frame is pending", () => {
    render(<>
      <ARXNativeChart workspaceId="comparison-2" symbol="EURUSD" timeframe="H4" showFeedStatus overlays={NO_OVERLAYS} />
      <ARXNativeChart workspaceId="comparison-3" symbol="EURUSD" timeframe="D1" showFeedStatus overlays={NO_OVERLAYS} />
    </>);
    expect(frames).toHaveLength(1);
    // A visibility change that leaves the tab visible changes nothing.
    setDocumentHidden(false);
    runTasks();
    expect(created).toHaveLength(0);
    // Hidden: no frame will come, so the queue moves on with tasks alone.
    setDocumentHidden(true);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
    runTasks();
    expect(inits()).toEqual(["1:init", "2:init"]);
    // The frame requested before the tab was hidden finally fires: no rebuild
    // (the stale frame with work still queued is covered by the next test).
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init", "2:init"]);
    expect(calls.filter(call => call.endsWith(":destroy"))).toEqual([]);
  });

  it("lets a stale frame after the hidden fallback start no second chain (one engine per turn)", () => {
    render(<>
      <ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />
      <ARXNativeChart workspaceId="comparison-2" symbol="EURUSD" timeframe="H4" showFeedStatus overlays={NO_OVERLAYS} />
      <ARXNativeChart workspaceId="comparison-3" symbol="EURUSD" timeframe="D1" showFeedStatus overlays={NO_OVERLAYS} />
    </>);
    expect(frames).toHaveLength(1);
    setDocumentHidden(true);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
    // The tab is visible again before the next job runs, and the frame
    // requested before it was hidden fires while the queue still has work.
    setDocumentHidden(false, false);
    runFrame();
    runTasks();
    expect(inits()).toEqual(["1:init", "2:init"]);
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init", "2:init", "3:init"]);
  });

  it("removes its visibility listener when the frame comes first", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    try {
      const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
      runFrame(); runTasks();
      expect(inits()).toEqual(["1:init"]);
      view.unmount();
      const visibility = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "visibilitychange").map(([, listener]) => listener);
      const added = visibility(add);
      expect(added.length).toBeGreaterThan(0);
      const removed = visibility(remove);
      expect(added.filter(listener => !removed.includes(listener))).toEqual([]);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("never builds an engine for a comparison unmounted before its deferred tick", () => {
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    runFrame();
    view.unmount();
    runTasks();
    runFrame();
    runTasks();
    expect(created).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("destroys a built comparison engine on unmount", () => {
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    view.unmount();
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "init", "setSymbol", "setTimeframe", "setCrosshairHandler", "setViewLinkStatusHandler"])("surfaces a deferred build that throws at %s to the error boundary and leaves no live engine", at => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      candleResponse = liveResponse("EURUSD", "H1");
      const view = render(<>
        <Boundary name="first"><ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} /></Boundary>
        <Boundary name="second"><ARXNativeChart workspaceId="comparison-2" symbol="EURUSD" timeframe="H4" showFeedStatus overlays={NO_OVERLAYS} /></Boundary>
      </>);
      // Only the H1 card has matching candles (and so a feed source and a stream).
      expect(streams.map(stream => stream.url)).toEqual([expect.stringContaining("timeframe=H1")]);
      setupFailure = { at, error: new Error(`engine setup failed at ${at}`) };
      // The throw happens in the post-paint task, outside React: it must not
      // escape that task (an uncaught throw fails this act) but reach the
      // card's boundary, as a failed synchronous build does.
      runFrame(); runTasks();
      expect(screen.getByTestId("boundary-first").textContent).toBe(`engine setup failed at ${at}`);
      expect(screen.queryByTestId("boundary-second")).toBeNull();
      expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(1);
      // The partly built engine is destroyed and never used again; the failed
      // card's stream is closed with it.
      const failed = at === "create" ? [] : [created[0]!];
      for (const engine of failed) {
        expect(engine.destroy).toHaveBeenCalledTimes(1);
        expect(calls.filter(call => call.startsWith(`${engine.id}:`)).at(-1)).toBe(`${engine.id}:destroy`);
      }
      expect(streams[0]!.closed).toBe(true);
      // The queue moves on: the next comparison still builds, one frame later.
      runFrame(); runTasks();
      expect(created).toHaveLength(failed.length + 1);
      const next = created[failed.length]!;
      expect(next.init).toHaveBeenCalledTimes(1);
      expect(next.resetDataContext).toHaveBeenCalled();
      expect(next.destroy).not.toHaveBeenCalled();
      view.unmount();
      for (const engine of failed) expect(engine.destroy).toHaveBeenCalledTimes(1);
      expect(next.destroy).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not replay an applied held tip when the built engine's context changes away and back", () => {
    candleResponse = liveResponse("EURUSD", "H1");
    const view = render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    act(() => streams[0]!.onmessage!(formingBar(1.1015)));
    runFrame(); runTasks();
    const engine = created[0]!;
    expect(engine.updateActiveCandle).toHaveBeenCalledTimes(1);
    candleResponse = liveResponse("EURUSD", "H4");
    view.rerender(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H4" showFeedStatus overlays={NO_OVERLAYS} />);
    candleResponse = liveResponse("EURUSD", "H1");
    view.rerender(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    // Back on H1, whose newest candle the pre-build tip still matches: the
    // engine was reset into H1 again, and that tip, already drawn once, is not.
    expect(engine.setTimeframe).toHaveBeenLastCalledWith("H1");
    expect(engine.resetDataContext).toHaveBeenCalledTimes(3);
    expect(engine.updateActiveCandle).toHaveBeenCalledTimes(1);
  });

  it("staggers new comparisons one engine per frame", () => {
    render(<>
      <ARXNativeChart workspaceId="comparison-2" symbol="EURUSD" timeframe="H4" showFeedStatus overlays={NO_OVERLAYS} />
      <ARXNativeChart workspaceId="comparison-3" symbol="EURUSD" timeframe="D1" showFeedStatus overlays={NO_OVERLAYS} />
    </>);
    expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(2);
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init", "2:init"]);
    expect(created[0]!.init.mock.calls[0]![0].container).toBe(screen.getAllByTestId("arx-native-canvas")[0]);
    expect(created[1]!.init.mock.calls[0]![0].container).toBe(screen.getAllByTestId("arx-native-canvas")[1]);
  });

  it("does not leak or double-build engines when toggling Four -> One -> Four within a frame", () => {
    const view = render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);
    fireEvent.click(screen.getByRole("button", { name: "Four charts" }));
    expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "One chart" }));
    expect(screen.queryAllByTestId("arx-native-chart")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Four charts" }));
    expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(3);
    // Layout persistence is written immediately, not deferred with the engines.
    expect(JSON.parse(localStorage.getItem(CHART_LAYOUT_KEY)!).count).toBe(4);
    expect(created).toHaveLength(0);

    for (let i = 0; i < 6; i++) { runFrame(); runTasks(); }
    expect(inits()).toHaveLength(3);
    expect(calls.filter(call => call.endsWith(":destroy"))).toEqual([]);
    const canvases = screen.getAllByTestId("arx-native-canvas");
    expect(created.map(adapter => adapter.init.mock.calls[0]![0].container)).toEqual(canvases);

    view.unmount();
    expect(created.every(adapter => adapter.destroy.mock.calls.length === 1)).toBe(true);
    expect(created.every(adapter => adapter.init.mock.calls.length === 1)).toBe(true);
  });

  it("registers each deferred engine with the view link once, after its build, and unregisters it on unmount", () => {
    const view = render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);
    fireEvent.click(screen.getByRole("button", { name: "Four charts" }));
    for (let i = 0; i < 3; i++) { runFrame(); runTasks(); }
    expect(inits()).toHaveLength(3);
    const handlers = created.map(adapter => adapter.setViewLinkHandler.mock.calls.filter(([handler]) => typeof handler === "function"));
    expect(handlers.map(registered => registered.length)).toEqual([1, 1, 1]);
    // The registration is live: a range published by one comparison reaches the others.
    fireEvent.click(screen.getByLabelText("Link time range"));
    const range = { from: OPEN_MS / 1000 - 7_200, to: OPEN_MS / 1000 };
    act(() => { (handlers[0]![0]![0] as (event: unknown) => void)({ kind: "range", range }); });
    expect(created[0]!.setLinkedTimeRange).not.toHaveBeenCalled();
    expect(created[1]!.setLinkedTimeRange).toHaveBeenCalledWith(range);
    expect(created[2]!.setLinkedTimeRange).toHaveBeenCalledWith(range);
    view.unmount();
    for (const adapter of created) {
      expect(adapter.setViewLinkHandler.mock.calls.filter(([handler]) => typeof handler === "function")).toHaveLength(1);
      expect(adapter.setViewLinkHandler).toHaveBeenLastCalledWith(null);
      expect(adapter.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves an already-mounted comparison alone when the layout grows", () => {
    render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);
    fireEvent.click(screen.getByRole("button", { name: "Two charts" }));
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init"]);
    fireEvent.click(screen.getByRole("button", { name: "Four charts" }));
    expect(screen.getAllByTestId("arx-native-chart")).toHaveLength(3);
    expect(created[0]!.destroy).not.toHaveBeenCalled();
    expect(inits()).toEqual(["1:init"]);
    runFrame(); runTasks();
    runFrame(); runTasks();
    expect(inits()).toEqual(["1:init", "2:init", "3:init"]);
    expect(created[0]!.init).toHaveBeenCalledTimes(1);
    expect(created[0]!.destroy).not.toHaveBeenCalled();
  });

  it("gives a deferred comparison the primary's stored display zone in its build, before the next frame", () => {
    candleResponse=liveResponse("EURUSD","H1");
    localStorage.setItem("arx.chart.preferences.v1", JSON.stringify({ style: "candles", scale: "linear", studies: [], timeZone: "Asia/Tokyo" }));
    render(<ARXNativeChart workspaceId="comparison" symbol="EURUSD" timeframe="H1" showFeedStatus overlays={NO_OVERLAYS} />);
    runFrame();
    expect(created).toHaveLength(0);
    runTasks();
    expect(inits()).toEqual(["1:init"]);
    // Applied inside the build task itself: no frame has run since.
    const order = calls.map(call => call.slice(2));
    expect(order.slice(0, 6)).toEqual(["init", "setSymbol", "setTimeframe", "setCrosshairHandler", "setViewLinkStatusHandler", "setDisplayTimeZone"]);
    expect(created[0]!.setDisplayTimeZone).toHaveBeenCalledWith("Asia/Tokyo");
    expect(created[0]!.setDisplayTimeZone.mock.calls.every(([zone]) => zone === "Asia/Tokyo")).toBe(true);
    expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    // The comparison's own key now diverges without touching the primary's.
    fireEvent.change(screen.getByLabelText("Display time zone"), { target: { value: "Europe/London" } });
    expect(created[0]!.setDisplayTimeZone).toHaveBeenLastCalledWith("Europe/London");
    expect(JSON.parse(localStorage.getItem("arx.chart.preferences.v1:comparison")!).timeZone).toBe("Europe/London");
    expect(JSON.parse(localStorage.getItem("arx.chart.preferences.v1")!).timeZone).toBe("Asia/Tokyo");
  });

  it("relabels an inspected candle's legend on a zone change without another crosshair move", () => {
    candleResponse=liveResponse("EURUSD","H1");
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={false} overlays={NO_OVERLAYS} />);
    const engine = created[0]!;
    const legend = engine.setCrosshairHandler.mock.calls.at(-1)![0] as (bar: unknown) => void;
    act(() => legend({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.102 }));
    const inspector = screen.getByTestId("chart-candle-inspector");
    // One instrument precision (lib/instrumentPriceFormat): no server-declared
    // precision here, so the loaded quotes' own digits (3) decide — the legend
    // prints what the axis and header print, not a fiat-pair guess.
    expect(inspector.textContent).toBe("2023-11-14 22:13 UTC  ·  O 1.101  H 1.103  L 1.100  C 1.102");
    const zoneCalls = engine.setDisplayTimeZone.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Display time zone"), { target: { value: "Asia/Tokyo" } });
    expect(engine.setDisplayTimeZone.mock.calls.slice(zoneCalls)).toEqual([["Asia/Tokyo"]]);
    expect(inspector.textContent).toBe("2023-11-15 07:13 GMT+9  ·  O 1.101  H 1.103  L 1.100  C 1.102");
    // Daily bars keep UTC whatever the stored zone.
    cleanup();
    candleResponse=liveResponse("EURUSD","D1");
    render(<ARXNativeChart symbol="EURUSD" timeframe="D1" showFeedStatus={false} overlays={NO_OVERLAYS} />);
    const daily = created.at(-1)!;
    expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    expect(daily.setDisplayTimeZone).toHaveBeenCalled();
    expect(daily.setDisplayTimeZone.mock.calls.every(([zone]) => zone === "UTC")).toBe(true);
    expect(screen.getByTestId("chart-daily-zone-note")).toBeTruthy();
    act(() => (daily.setCrosshairHandler.mock.calls.at(-1)![0] as (bar: unknown) => void)({ time: OPEN_MS / 1000, open: 1.101, high: 1.103, low: 1.1, close: 1.102 }));
    expect(screen.getByTestId("chart-candle-inspector").textContent!.startsWith("2023-11-14 22:13 UTC")).toBe(true);
  });
});

describe("current chart assistant binding",()=>{
  it("applies to primary only, updates saved manual settings and releases on unmount",()=>{
    candleResponse=liveResponse("EURUSD","H1");
    const view=render(<AssistantDockProvider><ARXNativeChart symbol="EURUSD" timeframe="H1"/></AssistantDockProvider>);
    const primary=created[0]!;
    primary.getVisibleCandles=vi.fn(()=>[{time:1700000000,open:1.1,high:1.2,low:1,close:1.15}]);
    primary.getStudyValues=vi.fn(()=>[{label:"RSI (14) · close",color:"#fff",values:[{name:"RSI",value:63.25}]}]);
    let reply:string|null=null;
    act(()=>{reply=requestChartStudy("show RSI");});
    expect(reply).toContain("RSI: 63.25");
    expect(reply).toContain("EURUSD · H1");
    expect(primary.setStudies).toHaveBeenLastCalledWith([expect.objectContaining({kind:"rsi",period:14})]);
    expect(localStorage.getItem("arx.chart.preferences.v1")).toContain('"rsi"');
    view.unmount();
    expect(requestChartStudy("show RSI")).toContain("Select a ready");
  });
  it("does not apply retained old data while the next asset has no matching response",()=>{
    candleResponse=liveResponse("EURUSD","H1");
    const view=render(<AssistantDockProvider><ARXNativeChart symbol="EURUSD" timeframe="H1"/></AssistantDockProvider>);
    const adapter=created[0]!;
    adapter.getVisibleCandles=vi.fn(()=>[{time:1700000000,open:1.1,high:1.2,low:1,close:1.15}]);
    adapter.getStudyValues=vi.fn(()=>[]);
    view.rerender(<AssistantDockProvider><ARXNativeChart symbol="USDJPY" timeframe="M5"/></AssistantDockProvider>);
    adapter.setStudies.mockClear();
    expect(requestChartStudy("show RSI")).toContain("Select a ready");
    expect(adapter.setStudies).not.toHaveBeenCalled();
    view.unmount();
  });
  it("a comparison does not hijack the chart assistant",()=>{
    candleResponse=liveResponse("EURUSD","H1");
    const view=render(<AssistantDockProvider><ARXNativeChart symbol="EURUSD" timeframe="H1"/><ARXNativeChart symbol="USDJPY" timeframe="M5" workspaceId="comparison"/></AssistantDockProvider>);
    created[0]!.getVisibleCandles=vi.fn(()=>[{time:1700000000,open:1.1,high:1.2,low:1,close:1.15}]);
    created[0]!.getStudyValues=vi.fn(()=>[]);
    let reply:string|null=null; act(()=>{reply=requestChartStudy("show RSI");});
    expect(reply).toContain("EURUSD · H1");
    view.unmount();
  });
});


describe("qualified volume handoff to native renderer",()=>{
  it("explains a selected but unavailable tick-volume pane without inventing zeros",()=>{
    candleResponse=liveResponse("EURUSD","H1");
    localStorage.setItem("arx.chart.preferences.v1",JSON.stringify({studies:[{kind:"tick_volume",period:1,color:"#38bdf8"}]}));
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1"/>);
    expect(screen.getByText(/Tick volume unavailable for these loaded candles/)).toBeTruthy();
  });
  it("preserves explicit source-qualified historical counts and never promotes partial ticks",()=>{
    const data=liveResponse("EURUSD","H1");
    const volumeEvidence={kind:"tick_count",quantity:42,unit:"ticks",reason:null};
    candleResponse={...data,candles:data.candles.map(bar=>({...bar,volumeEvidence}))};
    render(<ARXNativeChart symbol="EURUSD" timeframe="H1"/>);
    const engine=created[0]!;
    expect(engine.setCandles.mock.calls.at(-1)![0].at(-1).volumeEvidence).toEqual(volumeEvidence);
    act(()=>{streams[0]!.onmessage?.(formingBar(1.102));});
    expect(engine.updateActiveCandle.mock.calls.at(-1)![0].volumeEvidence).toBeUndefined();
  });
});

describe("native source-bound automatic Fibonacci",()=>{
  it("uses the applied Scanner chart and withdraws a preview when original evidence is revoked",()=>{
    const values=[10,11,15,12,11,7,10,11,16,12,11],start=OPEN_MS-24*3_600_000;
    const candles=values.map((p,i)=>({symbol:"EURUSD",timeframe:"H1",openTime:new Date(start+i*3_600_000).toISOString(),closeTime:new Date(start+(i+1)*3_600_000).toISOString(),open:p,high:p+1,low:p-1,close:p,source:"mt5_broker",sourceMode:"live",isComplete:true,isFinal:true,isForming:false,qualityFlags:[]}));
    const data={symbol:"EURUSD",timeframe:"H1",source:"mt5_broker",quality:"clean",candles,feedStatus:{symbol:"EURUSD",source:"mt5_broker",isLive:false,stale:true,warning:"Historical fixture"},marketEvidence:{symbol:"EURUSD",timeframe:"H1",source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}};
    candleResponse=data;const view=render(<ARXNativeChart symbol="EURUSD" timeframe="H1"/>);
    const engine=created[0]!;engine.getVisibleCandles=vi.fn(()=>candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close})));engine.setDrawings=vi.fn();
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
    expect(engine.setDrawings.mock.calls.at(-1)![0]).toEqual([expect.objectContaining({kind:"fibonacci",start:{time:(start+5*3_600_000)/1000,price:6},end:{time:(start+8*3_600_000)/1000,price:17},locked:true})]);
    candleResponse={...data,marketEvidence:undefined};view.rerender(<ARXNativeChart symbol="EURUSD" timeframe="H1"/>);
    expect(engine.setDrawings.mock.calls.at(-1)![0]).toEqual([]);
    expect(screen.queryByRole("button",{name:"Keep and edit Fibonacci"})).toBeNull();
  });
});


describe("original candle clock disclosure",()=>{
 it("keeps candles visible but withdraws zone conversion and UTC legend after evidence disappears",()=>{
  candleResponse=liveResponse("EURUSD","H1");
  localStorage.setItem("arx.chart.preferences.v1",JSON.stringify({style:"candles",scale:"linear",studies:[],timeZone:"Asia/Tokyo"}));
  const view=render(<ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
  const engine=created[0]!;
  act(()=>(engine.setCrosshairHandler.mock.calls.at(-1)![0] as (bar:unknown)=>void)({time:OPEN_MS/1000,open:1.101,high:1.103,low:1.1,close:1.102}));
  candleResponse=structuredClone(candleResponse);(candleResponse as any).candles.forEach((c:any)=>delete c.timeBasisEvidence);
  view.rerender(<ARXNativeChart symbol="EURUSD" timeframe="H1" showFeedStatus={false} overlays={NO_OVERLAYS}/>);
  expect(screen.getByTestId("chart-clock-authority").textContent).toContain("UTC mapping unverified");
  expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).disabled).toBe(true);
  expect(engine.setDisplayTimeZone).toHaveBeenLastCalledWith("UTC");
  expect(screen.getByTestId("chart-candle-inspector").textContent).toContain("source clock (UTC unverified)");
  expect(screen.getByTestId("chart-candle-inspector").textContent).toContain("O 1.101  H 1.103  L 1.100  C 1.102");
  expect(engine.setCandles).toHaveBeenCalled();expect(engine.destroy).not.toHaveBeenCalled();
 });
});


describe("explicit native comparison chart assistant",()=>{
 it("applies to selected stock only and withdraws on listing identity replacement without price changes",()=>{
  const primary=liveResponse('EURUSD','H1');
  const stock=(identity:string)=>{const response=liveResponse('AAPL','H1');return {...response,source:'assistant_real:twelve_data',marketEvidence:null,feedStatus:{...response.feedStatus,source:'assistant_real:twelve_data',isLive:false,quality:'delayed',aiUsable:false},candles:response.candles.map(bar=>({...bar,source:'assistant_real:twelve_data',volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:200,authority:'twelve-data:time-series:common-stock:regular-unadjusted:v1',seriesIdentity:identity,reason:null}}))};};
  const app=(identity:string)=><AssistantDockProvider><ARXNativeChart symbol="EURUSD" timeframe="H1" externalFeed={{data:primary,isLoading:false,isError:false,isFetching:false} as any}/><ARXNativeChart symbol="AAPL" timeframe="H1" workspaceId="comparison" externalFeed={{data:stock(identity),isLoading:false,isError:false,isFetching:false} as any}/></AssistantDockProvider>;
  const view=render(app('a'.repeat(64)));runFrame();runTasks();
  expect(created).toHaveLength(2);const eur=created[0]!,aapl=created[1]!;
  for(const adapter of created){adapter.getVisibleCandles=vi.fn(()=>[{time:1700000000,open:100,high:110,low:90,close:101}]);adapter.getStudyValues=vi.fn(()=>[{label:'RSI (14) · close',color:'#fff',values:[{name:'RSI',value:63.25}]}]);adapter.setStudies.mockClear();}
  const stockCard=screen.getAllByTestId('arx-native-chart')[1]!;
  fireEvent.click(within(stockCard).getByTestId('chart-assistant-activate'));
  let reply:string|null=null;act(()=>{reply=requestChartStudy('show RSI');});
  expect(reply).toContain('AAPL · H1');expect(reply).toContain('63.25');expect(aapl.setStudies).toHaveBeenLastCalledWith([expect.objectContaining({kind:'rsi'})]);expect(eur.setStudies).not.toHaveBeenCalled();
  expect(localStorage.getItem('arx.chart.preferences.v1:comparison')).toContain('rsi');expect(localStorage.getItem('arx.chart.preferences.v1')??'').not.toContain('rsi');
  view.rerender(app('b'.repeat(64)));eur.setStudies.mockClear();aapl.setStudies.mockClear();
  expect(requestChartStudy('show RSI')).toContain('Select a ready');expect(eur.setStudies).not.toHaveBeenCalled();expect(aapl.setStudies).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getAllByTestId('arx-native-chart')[1]!).getByTestId('chart-assistant-activate'));
  act(()=>{reply=requestChartStudy('show RSI');});expect(reply).toContain('AAPL · H1');
 });
});

describe("native selected historical follow-up routing",()=>{
 it("preserves frozen results and edited rules for polite explanations, loss questions and unsupported compound actions",async()=>{
  const start=Date.parse("2026-01-01T00:00:00Z"),step=60_000;
  const candles=Array.from({length:160},(_,i)=>{const close=100+Math.sin(i/5)*4;return {symbol:"EURUSD",timeframe:"M1",openTime:new Date(start+i*step).toISOString(),closeTime:new Date(start+(i+1)*step).toISOString(),open:close-.1,high:close+.3,low:close-.3,close,source:"mt5_broker",sourceMode:"live",priceBasis:"BID",priceBasisEvidence:{kind:"producer_declared",basis:"BID",reason:null},timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null},isComplete:true,isFinal:true,isForming:false,qualityFlags:[]};});
  candleResponse={symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",quality:"clean",candles,feedStatus:{source:"mt5_broker"},marketEvidence:{symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}};
  researchRunner.run.mockReset();researchRunner.cancel.mockReset();
  researchRunner.run.mockImplementation((input,config,receive)=>receive({status:"complete",result:runCausalResearchV2(input,config)}));
  const view=render(<AssistantDockProvider><ARXNativeChart symbol="EURUSD" timeframe="M1"/></AssistantDockProvider>);
  created[0]!.getVisibleCandles=vi.fn(()=>candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close})));
  await import("../testing-lab/ChartResearchWorkbench");
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Test an idea"}));});
  fireEvent.change(screen.getByLabelText("Fast EMA"),{target:{value:"12"}});
  fireEvent.click(screen.getByRole("button",{name:"Run historical test"}));
  fireEvent.click(screen.getByRole("button",{name:"Trade 1",exact:true}));
  const result=screen.getByTestId("chart-research-result"),before=result.textContent;
  for(const prompt of ["Please explain the last test trade!","Why did this trade lose?","explain the last test trade and buy"]){
   let reply:string|null=null;act(()=>{reply=requestChartResearch(prompt);});
   expect(reply).toMatch(/ledger-derived simulation|Additional actions or ambiguous/);
   expect(screen.getByTestId("chart-research-result")).toBe(result);expect(result.textContent).toBe(before);
   expect((screen.getByLabelText("Fast EMA") as HTMLInputElement).value).toBe("12");
  }
  expect(researchRunner.run).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button",{name:"Close historical test"}));
  let reply:string|null=null;act(()=>{reply=requestChartResearch("Why did this trade lose?");});
  expect(reply).toContain("No current selected historical result");expect(reply).not.toContain("ledger-derived simulation");
  // Recreate a selected receipt after the close check, then switch directly
  // while it is mounted: cleanup must not be the reason this assertion passes.
  fireEvent.click(screen.getByRole("button",{name:"Run historical test"}));
  fireEvent.click(screen.getByRole("button",{name:"Trade 1",exact:true}));
  act(()=>{reply=requestChartResearch("Why did this trade lose?");});
  expect(reply).toContain("ledger-derived simulation");
  const previous=candleResponse as any;
  candleResponse={...previous,symbol:"AAPL",candles:previous.candles.map((c:any)=>({...c,symbol:"AAPL"})),marketEvidence:{...previous.marketEvidence,symbol:"AAPL",sourceIdentity:"b".repeat(64)}};
  view.rerender(<AssistantDockProvider><ARXNativeChart symbol="AAPL" timeframe="M1"/></AssistantDockProvider>);
  act(()=>{reply=requestChartResearch("Why did this trade lose?");});
  expect(reply).toContain("No other pane was substituted");expect(reply).not.toContain("ledger-derived simulation");
  fireEvent.click(screen.getByTestId("chart-assistant-activate"));
  act(()=>{reply=requestChartResearch("Why did this trade lose?");});
  expect(reply).not.toContain("ledger-derived simulation");expect(reply).toMatch(/No completed historical test|No current selected historical result/);
  expect(researchRunner.run).toHaveBeenCalledTimes(2);
  view.unmount();expect(requestChartResearch("Why did this trade lose?")).toContain("Select a ready Smart Chart");
 });
});

describe("compact command-workspace chart", () => {
  it("resizes to spare desktop space and ignores delayed observer callbacks after unmount", () => {
    let notify = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const width = window.innerWidth;
    const height = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    try {
      const view = render(<ARXNativeChart symbol="EURUSD" timeframe="H1" height={320} compactWorkspace showFeedStatus={false} overlays={NO_OVERLAYS}/>);
      const engine = created[0]!;
      const canvas = screen.getByTestId("arx-native-canvas");
      Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 480 });
      engine.resize.mockClear();
      notify();
      expect(engine.resize).toHaveBeenCalledWith(undefined, 480);
      Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 1500 });
      notify();
      expect(engine.resize).toHaveBeenLastCalledWith(undefined, 540);
      expect(canvas.parentElement?.style.getPropertyValue("--arx-compact-plot-max")).toBe("585px");
      view.unmount();
      const calls = engine.resize.mock.calls.length;
      notify();
      expect(engine.resize).toHaveBeenCalledTimes(calls);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    }
  });
  it("keeps a usable plot in the embedded desktop range and keeps advanced tools separate", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    try {
      const view = render(<ARXNativeChart symbol="EURUSD" timeframe="H1" height={320} mobileHeight={270} compactWorkspace showFeedStatus={false} overlays={NO_OVERLAYS}/>);
      const canvas = screen.getByTestId("arx-native-canvas");
      expect(canvas.style.height).toBe("390px");
      const details = screen.getByTestId("arx-native-advanced-details") as HTMLDivElement;
      expect(details.hidden).toBe(true);
      const advancedToggle = screen.getByRole("button", { name: "Advanced chart details" });
      expect(advancedToggle.getAttribute("aria-expanded")).toBe("false");
      const timeframeToolbar = screen.getByTestId("arx-native-tf-controls");
      expect(timeframeToolbar.contains(advancedToggle)).toBe(true);
      expect(timeframeToolbar.contains(screen.getByTestId("arx-native-reset-scale"))).toBe(true);
      expect(screen.queryByRole("toolbar", { name: "Chart view controls" })).toBeNull();
      fireEvent.click(advancedToggle);
      expect(advancedToggle.getAttribute("aria-expanded")).toBe("true");
      expect(details.hidden).toBe(false);
      expect(screen.getByRole("toolbar", { name: "Chart view controls" })).toBeTruthy();
      view.unmount();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });
});
