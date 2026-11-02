import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  engineId: "arx-native",
  engines: [] as Array<{ maximized:string|null; verified: boolean; listeners: Set<() => void>; retired: Array<() => void>; unsubscribe: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; isAnalysisFocusVerified: ReturnType<typeof vi.fn> }>,
}));
vi.mock("@/lib/chart-engine", () => ({ createChartEngineAdapter: () => {
  const engine = {
    maximized:null as string|null, getMaximizedStudyPane:()=>engine.maximized, capabilities: { id: state.engineId }, verified: false, listeners: new Set<() => void>(), retired: [] as Array<() => void>,
    unsubscribe: vi.fn(), destroy: vi.fn(), isAnalysisFocusVerified: vi.fn(() => engine.verified),
    subscribeViewport: (listener: () => void) => { engine.listeners.add(listener); engine.retired.push(listener); return () => { engine.unsubscribe(); engine.listeners.delete(listener); }; },
    init: vi.fn(), setSymbol: vi.fn(), setTimeframe: vi.fn(), setCrosshairHandler: vi.fn(), setViewLinkStatusHandler: vi.fn(),
    resetDataContext: vi.fn(), setFeedState: vi.fn(), setCandles: vi.fn(), setOverlays: vi.fn(), setStudies: vi.fn(),
    setChartStyle: vi.fn(), setScaleMode: vi.fn(), resize: vi.fn(), setReachStartHandler: vi.fn(), setDisplayTimeZone: vi.fn(),
    priceToCoordinate: () => null,
  };
  state.engines.push(engine);
  return engine;
} }));
vi.mock("@/lib/useChartDeepHistory", () => ({ useChartDeepHistory: () => ({ olderCandles: [], loading: false, hasMore: false,
  providerCapped: false, limitationReason: null, coverageDays: 0, depthTargetDays: 0, loadedAny: false, loadOlder: vi.fn(), reset: vi.fn() }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetChartCandles: () => ({ data: undefined, isLoading: false, isError: false, isFetching: false }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: undefined, error: null }), getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null, feedStatus: null, isLoading: false, isError: false, refetch: vi.fn() }) }));
import { ARXNativeChart } from "./ARXNativeChart";
const chart = (key = "first") => <ARXNativeChart key={key} symbol="EURUSD" timeframe="H1" showFeedStatus={false} />;
const proofWarning = () => screen.queryByText(/Chart layer visibility is unverified/);
function paint(engine: typeof state.engines[number], verified: boolean) {
  act(() => { engine.verified = verified; for (const listener of engine.listeners) listener(); });
}
beforeEach(() => {
  state.engineId = "arx-native"; state.engines.length = 0; localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("active renderer attribution and completed-paint proof", () => {
  it("names ARX native only for the instantiated native engine", () => {
    render(chart());
    expect(screen.getByTestId("chart-native-credit").textContent).toBe("Rendering engine: ARX Native Chart");
    expect(screen.queryByTestId("chart-library-credit")).toBeNull();
    expect(screen.queryByRole("link", {name: /TradingView/})).toBeNull();
  });
  it("retains the real library attribution when Lightweight Charts is active", () => {
    state.engineId = "lightweight-charts"; render(chart());
    expect(screen.getByTestId("chart-library-credit").textContent).toContain("TradingView Lightweight Charts");
    expect(screen.queryByTestId("chart-native-credit")).toBeNull();
  });
  it("does not misdiagnose a pending first paint as a rendering failure", () => {
    render(chart()); expect(proofWarning()).not.toBeNull();
    expect(proofWarning()!.textContent).not.toContain("after a rendering failure");
  });
  it("rechecks completed paint proof, retains false proof, and withdraws recovered warnings", () => {
    render(chart()); const engine = state.engines[0]!;
    expect(proofWarning()).not.toBeNull();
    paint(engine, false); expect(proofWarning()).not.toBeNull();
    paint(engine, true); expect(proofWarning()).toBeNull();
    paint(engine, false); expect(proofWarning()).not.toBeNull();
    paint(engine, true); expect(proofWarning()).toBeNull();
  });
  it("unsubscribes on replacement and rejects retained old-engine callbacks", () => {
    const view = render(chart()); const old = state.engines[0]!;
    paint(old, true); expect(proofWarning()).toBeNull();
    view.rerender(chart("second")); const current = state.engines[1]!;
    expect(old.unsubscribe).toHaveBeenCalled(); expect(old.listeners.size).toBe(0); expect(old.destroy).toHaveBeenCalledOnce();
    expect(proofWarning()).not.toBeNull();
    const reads = old.isAnalysisFocusVerified.mock.calls.length;
    act(() => { old.verified = true; old.retired[0]!(); });
    expect(old.isAnalysisFocusVerified).toHaveBeenCalledTimes(reads);
    expect(proofWarning()).not.toBeNull();
    paint(current, true); expect(proofWarning()).toBeNull();
    view.unmount(); expect(current.unsubscribe).toHaveBeenCalled(); expect(current.listeners.size).toBe(0);
    const finalReads = current.isAnalysisFocusVerified.mock.calls.length;
    act(() => { current.retired[0]!(); });
    expect(current.isAnalysisFocusVerified).toHaveBeenCalledTimes(finalReads);
  });
});

it('reports maximized panes from the current renderer and retires the notice on restore',()=>{
 render(chart());const engine=state.engines[0]!;engine.maximized='rsi';paint(engine,true);
 expect(screen.getByTestId('chart-maximized-pane').textContent).toContain('Price candles, drawings, trade overlays, automatic annotations and other panes are hidden');
 engine.maximized=null;paint(engine,true);expect(screen.queryByTestId('chart-maximized-pane')).toBeNull();
});
