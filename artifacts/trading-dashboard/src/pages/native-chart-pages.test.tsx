import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({investor:false, roleLoading:false}));
vi.mock("@/components/charts/ARXNativeChart", () => ({ARXNativeChart:(p:any)=><output data-testid="native-chart">{p.symbol}:{p.timeframe ?? "default"}</output>}));
vi.mock("@/components/charts/SmartChartLayout", () => ({SmartChartLayout:({children}:any)=><div>{children}</div>}));
vi.mock("@/lib/chart-engine", () => ({DEFAULT_CHART_ENGINE_ID:"native",CHART_ENGINE_DESCRIPTORS:{native:{label:"ARX native renderer"}}}));
vi.mock("@/hooks/useTradingMode", () => ({useTradingMode:()=>({cleanModeLabel:"PAPER",isLiveShared:false,isAdminPreviewingUserMode:false})}));
vi.mock("@/hooks/useProductRole", () => ({useProductRole:()=>({isInvestor:state.investor,isLoading:state.roleLoading})}));
vi.mock("@/hooks/useViewMode", () => ({useViewMode:()=>({effectiveIsAdmin:false})}));
vi.mock("@/hooks/useFeatureUnlock", () => ({useAllUnlocks:()=>({mt5:false,simulator:false})}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({useMasterLiveAccess:()=>({loaded:true,canTrade:false})}));
vi.mock("@/lib/assistant-name", () => ({useAssistantName:()=>({name:"Ruby"})}));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({LiveSharedTradeTicket:()=>null}));
vi.mock("@/hooks/useLivePositionOverlays", () => ({useLivePositionOverlays:()=>({overlays:[]})}));
vi.mock("@/hooks/useAiChartOverlays", () => ({useAiChartOverlays:()=>({overlays:[]})}));
vi.mock("@/hooks/useChartSetupPreview", () => ({useChartSetupPreview:()=>({overlays:[],confirm:()=>{}})}));
vi.mock("@/components/charts/ChartPositionOverlayPanel", () => ({ChartPositionOverlayPanel:()=>null}));
vi.mock("@/components/charts/ChartAiOverlayPanel", () => ({ChartAiOverlayPanel:()=>null}));
vi.mock("@/components/charts/ChartSetupPreviewPanel", () => ({ChartSetupPreviewPanel:()=>null}));
vi.mock("@/components/charts/ChartModes", () => ({ChartModes:()=>null}));
vi.mock("@/components/charts/ChartTradeEntry", () => ({ChartTradeEntry:()=> <div data-testid="trade-entry"/>}));
vi.mock("@/components/positions/PositionPickerPanel", () => ({PositionPickerPanel:()=> <div data-testid="position-picker"/>}));

import LiveChartPage from "./live-chart";
import LiveManualPage from "./live-manual";
import LiveAiAssistPage from "./live-ai-assist";
import LiveAiAutoTestPage from "./live-ai-auto-test";
import { SafetyHeader } from "@/components/ss/SafetyHeader";
import { setChartSymbol } from "@/lib/use-chart-symbol";

const response = (body:unknown) => ({ok:true,status:200,json:async()=>body,text:async()=>JSON.stringify(body)}) as Response;
beforeEach(() => {
  localStorage.clear(); state.investor=false; state.roleLoading=false;
  vi.stubGlobal("fetch", vi.fn(async()=>response({})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("ignores the old persisted external-renderer choice and retains native timeframe, ticket and position controls", () => {
  localStorage.setItem("arx.chart.view.v1", JSON.stringify("tv"));
  localStorage.setItem("arx.chart.primaryTimeframe.v1", JSON.stringify("H4"));
  render(<LiveChartPage/>);
  expect(screen.getByTestId("native-chart").textContent).toBe("V75:H4");
  expect(screen.queryByRole("tab", {name:/TradingView/})).toBeNull();
  expect(screen.getByTestId("trade-entry")).toBeTruthy();
  expect(screen.getByTestId("position-picker")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox",{name:"Chart market"}),{target:{value:"GBPUSD"}});
  expect(screen.getByTestId("native-chart").textContent).toBe("GBPUSD:H4");
});

it.each([{investor:true,roleLoading:false},{investor:false,roleLoading:true}])("keeps the trade ticket withheld for role state %j", value => {
  Object.assign(state,value); render(<LiveChartPage/>);
  expect(screen.queryByTestId("trade-entry")).toBeNull();
  expect(screen.getByTestId("native-chart")).toBeTruthy();
});

it("retains manual ticket values, exact selected market and confirmation while chart selection stays read-only", async () => {
  render(<LiveManualPage/>);
  fireEvent.change(screen.getByTestId("ticket-lot"),{target:{value:"0.02"}});
  fireEvent.change(screen.getByRole("combobox",{name:"Chart market"}),{target:{value:"XAUUSD"}});
  expect(screen.getByTestId("ticket-symbol")).toHaveProperty("value","XAUUSD");
  expect(screen.getByTestId("native-chart").textContent).toBe("XAUUSD:default");
  expect(screen.getByTestId("ticket-lot")).toHaveProperty("value","0.02");
  fireEvent.change(screen.getByTestId("ticket-symbol"),{target:{value:"UNKNOWN"}});
  expect(screen.queryByTestId("native-chart")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("UNKNOWN");
  await waitFor(()=>expect(fetch).toHaveBeenCalled());
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method || init.method==="GET")).toBe(true);
  fireEvent.click(screen.getByTestId("ticket-submit"));
  expect(screen.getByTestId("ticket-confirm-submit")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
});

it("keeps AI analysis and its chart on the selected synthetic instead of substituting EURUSD", async () => {
  render(<LiveAiAssistPage/>);
  expect(screen.getByTestId("native-chart").textContent).toBe("V75:default");
  expect(screen.getByTestId("ai-symbol-select")).toHaveProperty("value","V75");
  fireEvent.click(screen.getByTestId("generate-card"));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes("selected-market?symbol=V75&timeframe=M15"))).toBe(true));
  fireEvent.change(screen.getByTestId("ai-symbol-select"),{target:{value:"XAUUSD"}});
  expect(screen.getByTestId("native-chart").textContent).toBe("XAUUSD:default");
});

it("leaves the audit loop stopped while the test page follows the shared selected chart", () => {
  render(<LiveAiAutoTestPage/>);
  act(()=>setChartSymbol("GBPUSD"));
  expect(screen.getByTestId("native-chart").textContent).toBe("GBPUSD:default");
  expect(screen.getByText(/fixed EURUSD input/)).toBeTruthy();
  expect(screen.getByTestId("auto-start")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.method==="POST")).toBe(false);
});

it("never interprets a loaded chart library as a live feed in the safety header", () => {
  (window as any).TradingView={widget:()=>{}};
  render(<SafetyHeader/>);
  expect(screen.queryByText("Live Chart")).toBeNull();
  delete (window as any).TradingView;
});
