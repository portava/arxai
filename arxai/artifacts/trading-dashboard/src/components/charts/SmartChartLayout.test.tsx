import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./ARXNativeChart",()=>({ARXNativeChart:(props:any)=><button data-testid="secondary" data-workspace={props.workspaceId} onClick={()=>props.onTimeframeChange("H4")}>{props.symbol}:{props.timeframe}:{String(!!props.onChartContextChange)}</button>}));
vi.mock("@/components/scanner/SymbolExplorer",()=>({SymbolExplorer:(props:any)=><button onClick={()=>props.onSelect("GBPUSD")}>Select GBPUSD</button>}));
import { SmartChartLayout } from "./SmartChartLayout";
import { CHART_LAYOUT_KEY, validateChartLayout } from "@/lib/chart-engine/chartLayout";
beforeEach(()=>localStorage.clear());afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("keeps the primary mounted while adding an independent read-only comparison and remembers layout",()=>{
  const view=render(<SmartChartLayout symbol="EURUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  const primary=screen.getByLabelText("Primary state");fireEvent.click(screen.getByRole("button",{name:"Two charts"}));
  expect(screen.getByLabelText("Primary state")).toBe(primary);expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H1:false");
  fireEvent.click(screen.getByTestId("secondary"));expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H4:false");
  view.rerender(<SmartChartLayout symbol="XAUUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("XAUUSD:H4:false");view.unmount();
  render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H4:false");
});
it("retains independent instruments, interval settings and primary state across four / one / two views",()=>{
  const view=render(<SmartChartLayout symbol="EURUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  const primary=screen.getByLabelText("Primary state");fireEvent.click(screen.getByRole("button",{name:"Four charts"}));
  expect(screen.getAllByTestId("secondary").map(node=>node.getAttribute("data-workspace"))).toEqual(["comparison","comparison-2","comparison-3"]);
  const second=screen.getByRole("region",{name:"Comparison chart 2"});
  fireEvent.click(within(second).getByText(/Instrument:/));fireEvent.click(within(second).getByRole("button",{name:"Select GBPUSD"}));
  fireEvent.click(screen.getByLabelText("Link crosshair"));fireEvent.click(screen.getByLabelText("Link time range"));
  view.rerender(<SmartChartLayout symbol="XAUUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  expect(screen.getAllByTestId("secondary").map(node=>node.textContent)).toEqual(["XAUUSD:H1:false","GBPUSD:H4:false","XAUUSD:D1:false"]);
  fireEvent.click(screen.getByRole("button",{name:"One chart"}));expect(screen.getByLabelText("Primary state")).toBe(primary);
  expect(screen.queryByTestId("secondary")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Four charts"}));expect(within(screen.getByRole("region",{name:"Comparison chart 2"})).getByTestId("secondary").textContent).toBe("GBPUSD:H4:false");
  expect((screen.getByLabelText("Link crosshair") as HTMLInputElement).checked).toBe(true);
  expect(JSON.parse(localStorage.getItem(CHART_LAYOUT_KEY)!).comparisons[1].symbol).toBe("GBPUSD");
  expect(screen.getByLabelText("Primary state")).toBe(primary);
});
it("migrates the previous layout and validates malformed persisted data",()=>{
  localStorage.setItem("arx.chart.layout.v1",JSON.stringify({count:2,timeframe:"M30"}));
  render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:M30:false");
  expect(validateChartLayout({count:99,comparisons:[{symbol:"<script>",timeframe:"S1"},null],range:"true"})).toEqual({count:1,comparisons:[{symbol:null,timeframe:"H1"},{symbol:null,timeframe:"H4"},{symbol:null,timeframe:"D1"}],range:false,crosshair:false});
});
it("shows storage refusal instead of promising persistence",()=>{
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
  render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);
  expect(screen.getByRole("alert").textContent).toContain("will reset");
});
