import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { comparisonFixture, start } from "@/lib/chart-engine/chartPerformanceComparison.fixture";
import type { ChartEngineAdapter } from "@/lib/chart-engine/types";
const mock=vi.hoisted(()=>({query:{data:undefined as any,isError:false,isLoading:false},hook:vi.fn()}));
vi.mock("@workspace/api-client-react",()=>({useGetChartCandles:(...args:any[])=>{mock.hook(...args);return mock.query;},getGetChartCandlesQueryKey:(args:any)=>["candles",args]}));
vi.mock("@/components/scanner/SymbolExplorer",()=>({SymbolExplorer:({onSelect}:any)=><><button onClick={()=>onSelect("GBPUSD")}>Select GBPUSD</button><button onClick={()=>onSelect("USDJPY")}>Select USDJPY</button></>}));
import { ChartPerformanceComparison } from "./ChartPerformanceComparison";
let listener:(()=>void)|undefined;
let times:number[];
let unsubscribe:ReturnType<typeof vi.fn>;
let adapter:ChartEngineAdapter;
beforeEach(()=>{
  vi.spyOn(Date,"now").mockReturnValue((start+2000)*1000);
  mock.query={data:comparisonFixture("GBPUSD",[50,60,45,55]),isError:false,isLoading:false};mock.hook.mockClear();
  times=[start,start+300,start+600,start+900];unsubscribe=vi.fn();
  adapter={getVisibleCandles:()=>times.map(time=>({time})),subscribeViewport:(fn:()=>void)=>{listener=fn;return unsubscribe;}} as unknown as ChartEngineAdapter;
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const tree=(props:Partial<Parameters<typeof ChartPerformanceComparison>[0]>={})=><ChartPerformanceComparison symbol="EURUSD" timeframe="M5" data={comparisonFixture()} readFailed={false} adapter={adapter} epoch="one" onClose={()=>{}} {...props}/>;
it("keeps the extra request disabled until an instrument is selected; shows qualified relative changes",()=>{
  render(tree());expect(mock.hook.mock.lastCall![1].query.enabled).toBe(false);expect(screen.queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByText("Select GBPUSD"));
  expect(mock.hook.mock.lastCall![1].query.enabled).toBe(true);expect(mock.hook.mock.lastCall![0]).toEqual({symbol:"GBPUSD",timeframe:"M5",limit:200});
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("EURUSD and GBPUSD");
  expect(screen.getByText(/Baseline:/).textContent).toContain("EURUSD 100 · GBPUSD 50");
  expect(screen.getByText(/no currency conversion/)).toBeTruthy();
});
it("responds to native pan and zoom and unsubscribes on close",()=>{
  const view=render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));
  act(()=>{times=[start+600,start+900];listener?.();});
  expect(screen.getByText(/Baseline:/).textContent).toContain("EURUSD 120 · GBPUSD 45");
  view.unmount();expect(unsubscribe).toHaveBeenCalledOnce();
});
it("withdraws the previous instrument immediately during a selection change",()=>{
  render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));expect(screen.getByRole("img")).toBeTruthy();
  fireEvent.click(screen.getByText("Select USDJPY"));
  expect(screen.queryByRole("img")).toBeNull();expect(screen.getByRole("status").textContent).toContain("USDJPY: waiting for matching source candles");
});
it("never shows cached comparison results after either source read fails",()=>{
  const view=render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));
  mock.query.isError=true;view.rerender(tree());expect(screen.queryByRole("img")).toBeNull();expect(screen.getByRole("status").textContent).toContain("GBPUSD: the latest source read failed");
  mock.query.isError=false;view.rerender(tree({readFailed:true}));expect(screen.queryByRole("img")).toBeNull();expect(screen.getByRole("status").textContent).toContain("EURUSD: the latest source read failed");
});
it("withdraws on missing UTC evidence and exposes all observed values accessibly",()=>{
  const view=render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));expect(screen.getAllByRole("row")).toHaveLength(5);
  const data=comparisonFixture();delete data.candles[0]!.timeBasisEvidence;view.rerender(tree({data}));
  expect(screen.queryByRole("img")).toBeNull();expect(screen.getByRole("status").textContent).toContain("UTC timestamps are unverified");
});
it("source correction at the same timestamp recalculates the percentages",()=>{
  const view=render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));
  const data=comparisonFixture("GBPUSD",[100,60,45,55]);mock.query.data=data;view.rerender(tree());
  expect(screen.getByText(/Baseline:/).textContent).toContain("GBPUSD 100");expect(screen.getAllByRole("row").at(-1)!.textContent).toContain("-45%");
});
it("retains a huge finite outlier without overflowing SVG coordinates",()=>{
  mock.query.data=comparisonFixture("GBPUSD",[2,3.4e306,2,2]);
  render(tree());fireEvent.click(screen.getByText("Select GBPUSD"));
  const svg=screen.getByRole("img");expect(svg.innerHTML).not.toMatch(/NaN|Infinity/);
  const points=svg.querySelectorAll('[data-comparison-series="comparison"] circle');
  expect(points).toHaveLength(4);expect(Number(points[1]!.getAttribute("cy"))).toBeLessThan(Number(points[0]!.getAttribute("cy")));
});
