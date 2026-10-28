// Regression: after the chart symbol switched (EURUSD -> V75), Chart Pulse and
// the Chart Modes panels kept showing EURUSD's intelligence under the V75 chart
// until V75's own /me/chart/intelligence response arrived, because the chart
// only reports a state when one matches and the page held the last one.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useEffect } from "react";

type State = { symbol: string; timeframe: string };
// The intelligence responses the mocked chart has "received", by symbol.
const responses = new Map<string, State>();
let currentSymbol = "EURUSD";
let setSymbolExternal: ((s: string) => void) | null = null;

vi.mock("@/lib/use-chart-symbol", async () => {
  const react = await import("react");
  return {
    bareSymbol: (s: string) => s.replace(/^.*:/, ""),
    useChartSymbol: () => {
      const [s, set] = react.useState(currentSymbol);
      setSymbolExternal = set;
      return [s, set];
    },
  };
});
vi.mock("@/components/charts/ARXNativeChart", () => ({
  ARXNativeChart: (props: { symbol: string; timeframe: string; onIntelligenceChange?: (s: State) => void; onChartContextChange?: (c: { symbol: string; timeframe: string; aiUsable: boolean }) => void }) => {
    const sym = props.symbol.replace(/^.*:/, "").toUpperCase();
    const st = responses.get(sym);
    useEffect(() => { props.onChartContextChange?.({ symbol: sym, timeframe: props.timeframe, aiUsable: true }); }, [sym, props.timeframe]);
    useEffect(() => { if (st && st.timeframe === props.timeframe) props.onIntelligenceChange?.(st); }, [st, props.timeframe]);
    return <div data-testid="native-chart">{sym}</div>;
  },
}));
vi.mock("@/components/charts/ChartModes", () => ({
  ChartModes: ({ state }: { state: State | null }) => <div data-testid="chart-modes-state">{state ? state.symbol : "none"}</div>,
}));
vi.mock("@/components/charts/SmartChartLayout", () => ({ SmartChartLayout: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/charts/TradingViewLiveChart", () => ({ default: () => null }));
vi.mock("@/components/charts/ChartPositionOverlayPanel", () => ({ ChartPositionOverlayPanel: () => null }));
vi.mock("@/components/charts/ChartAiOverlayPanel", () => ({ ChartAiOverlayPanel: () => null }));
vi.mock("@/components/charts/ChartSetupPreviewPanel", () => ({ ChartSetupPreviewPanel: () => null }));
vi.mock("@/components/charts/ChartTradeEntry", () => ({ ChartTradeEntry: () => null }));
vi.mock("@/components/positions/PositionPickerPanel", () => ({ PositionPickerPanel: () => null }));
vi.mock("@/hooks/useLivePositionOverlays", () => ({ useLivePositionOverlays: () => ({ overlays: [] }) }));
vi.mock("@/hooks/useAiChartOverlays", () => ({ useAiChartOverlays: () => ({ overlays: [] }) }));
vi.mock("@/hooks/useChartSetupPreview", () => ({ useChartSetupPreview: () => ({ overlays: [], confirm: () => {} }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ envelope: null, cleanModeLabel: "Demo", isLiveShared: false }) }));
vi.mock("@/hooks/useProductRole", () => ({ useProductRole: () => ({ isInvestor: false, isLoading: false }) }));
vi.mock("@/lib/chart-engine/chartWorkspace", () => ({ readChartStorage: () => null, writeChartStorage: () => {} }));
vi.mock("@/lib/chart-engine", () => ({ CHART_ENGINE_DESCRIPTORS: { lw: { label: "lightweight-charts" } }, DEFAULT_CHART_ENGINE_ID: "lw" }));

const { default: LiveChartPage } = await import("./live-chart");

afterEach(() => { cleanup(); responses.clear(); currentSymbol = "EURUSD"; });

describe("Smart Chart intelligence follows the chart's symbol", () => {
  it("does not keep the previous symbol's intelligence after a symbol switch", async () => {
    responses.set("EURUSD", { symbol: "EURUSD", timeframe: "M15" });
    render(<LiveChartPage />);
    expect(screen.getByTestId("chart-modes-state").textContent).toBe("EURUSD");

    await act(async () => { setSymbolExternal!("V75"); });
    expect(screen.getByTestId("native-chart").textContent).toBe("V75");
    // V75's intelligence has not arrived: the panels must not show EURUSD's.
    expect(screen.getByTestId("chart-modes-state").textContent).toBe("none");

    responses.set("V75", { symbol: "V75", timeframe: "M15" });
    await act(async () => { setSymbolExternal!("FX:V75"); });
    expect(screen.getByTestId("chart-modes-state").textContent).toBe("V75");
  });
});
