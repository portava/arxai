import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./ARXNativeChart",()=>({ARXNativeChart:(props:any)=><button data-testid="secondary" data-workspace={props.workspaceId} onClick={()=>props.onTimeframeChange("H4")}>{props.symbol}:{props.timeframe}:{String(!!props.onChartContextChange)}</button>}));
vi.mock("@/components/scanner/SymbolExplorer",()=>({SymbolExplorer:(props:any)=><button onClick={()=>props.onSelect("GBPUSD")}>Select GBPUSD</button>}));
import { SmartChartLayout } from "./SmartChartLayout";
import { CHART_LAYOUT_KEY, SCANNER_CHART_LAYOUT_KEY, validateChartLayout } from "@/lib/chart-engine/chartLayout";
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

it("keeps Scanner layout choices separate from the Live Chart and legacy layouts",()=>{
  const live={count:4,comparisons:[{symbol:"GBPUSD",timeframe:"H4"}],crosshair:true,range:true};
  localStorage.setItem(CHART_LAYOUT_KEY,JSON.stringify(live));
  localStorage.setItem("arx.chart.layout.v1",JSON.stringify({count:2,timeframe:"M30"}));
  const view=render(<SmartChartLayout symbol="EURUSD" storageKey={SCANNER_CHART_LAYOUT_KEY}><input aria-label="Primary state" /></SmartChartLayout>);
  expect(screen.queryByTestId("secondary")).toBeNull();
  const primary=screen.getByLabelText("Primary state");
  fireEvent.click(screen.getByRole("button",{name:"Two charts"}));
  expect(screen.getByLabelText("Primary state")).toBe(primary);
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H1:false");
  expect(JSON.parse(localStorage.getItem(CHART_LAYOUT_KEY)!)).toEqual(live);
  expect(JSON.parse(localStorage.getItem(SCANNER_CHART_LAYOUT_KEY)!).count).toBe(2);
  view.unmount();
  render(<SmartChartLayout symbol="EURUSD" storageKey={SCANNER_CHART_LAYOUT_KEY}><div>Primary</div></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H1:false");
});

it("follows the primary interval without remounting primary, and detaches at the current interval",()=>{
  const tree=(tf:"M15"|"H8"|"M5")=><SmartChartLayout symbol="EURUSD" primaryTimeframe={tf}><input aria-label="Primary state" /></SmartChartLayout>;
  const view=render(tree("M15"));const primary=screen.getByLabelText("Primary state");
  fireEvent.click(screen.getByRole("button",{name:"Two charts"}));
  fireEvent.click(screen.getByLabelText("Follow primary interval"));
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:M15:false");
  view.rerender(tree("H8"));expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H8:false");
  fireEvent.click(screen.getByLabelText("Follow primary interval"));
  view.rerender(tree("M5"));expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H8:false");
  expect(screen.getByLabelText("Primary state")).toBe(primary);
});
it("choosing a comparison interval ends following without changing its independent instrument",()=>{
  const tree=(tf:"M15"|"M5")=><SmartChartLayout symbol="EURUSD" primaryTimeframe={tf}><div>Primary</div></SmartChartLayout>;
  const view=render(tree("M15"));fireEvent.click(screen.getByRole("button",{name:"Two charts"}));
  fireEvent.click(screen.getByRole("button",{name:"Select GBPUSD"}));
  fireEvent.click(screen.getByLabelText("Follow primary interval"));
  expect(screen.getByTestId("secondary").textContent).toBe("GBPUSD:M15:false");
  fireEvent.click(screen.getByTestId("secondary"));
  expect((screen.getByLabelText("Follow primary interval") as HTMLInputElement).checked).toBe(false);
  view.rerender(tree("M5"));expect(screen.getByTestId("secondary").textContent).toBe("GBPUSD:H4:false");
});
it("restores following and carries held calendar intervals instead of silently substituting H1",()=>{
  localStorage.setItem(CHART_LAYOUT_KEY,JSON.stringify({count:2,comparisons:[{timeframe:"H1",followPrimaryInterval:true}]}));
  const view=render(<SmartChartLayout symbol="EURUSD" primaryTimeframe="W1"><div>Primary</div></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:W1:false");
  view.rerender(<SmartChartLayout symbol="EURUSD" primaryTimeframe="MN1"><div>Primary</div></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:MN1:false");
  expect(JSON.parse(localStorage.getItem(CHART_LAYOUT_KEY)!).comparisons[0].followPrimaryInterval).toBe(true);
});
it("validates follow preferences strictly and preserves independent legacy defaults",()=>{
  const result=validateChartLayout({comparisons:[{followPrimaryInterval:"true"},{followPrimaryInterval:true},{followPrimaryInterval:1}]});
  expect(result.comparisons.map(v=>v.followPrimaryInterval)).toEqual([undefined,true,undefined]);
  expect(result.comparisons.map(v=>v.timeframe)).toEqual(["H1","H4","D1"]);
});
it("hidden comparisons follow the current primary interval when restored",()=>{
  const tree=(tf:"M15"|"H8")=><SmartChartLayout symbol="EURUSD" primaryTimeframe={tf}><div>Primary</div></SmartChartLayout>;
  const view=render(tree("M15"));fireEvent.click(screen.getByRole("button",{name:"Four charts"}));
  fireEvent.click(within(screen.getByRole("region",{name:"Comparison chart 3"})).getByLabelText("Follow primary interval"));
  fireEvent.click(screen.getByRole("button",{name:"One chart"}));view.rerender(tree("H8"));
  fireEvent.click(screen.getByRole("button",{name:"Four charts"}));
  expect(screen.getAllByTestId("secondary").map(n=>n.textContent)).toEqual(["EURUSD:H1:false","EURUSD:H4:false","EURUSD:H8:false"]);
});
