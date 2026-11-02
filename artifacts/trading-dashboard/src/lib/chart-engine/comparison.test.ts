import {expect,it} from "vitest";
import {createChartEngineAdapter,CHART_ENGINE_DESCRIPTORS} from "./comparison";
import {LightweightChartsAdapter} from "./lightweightChartsAdapter";
import {CHART_ENGINE_DESCRIPTORS as appDescriptors} from "./index";
it("legacy comparison remains explicitly available outside the app entry",()=>{
 expect(createChartEngineAdapter("lightweight-charts")).toBeInstanceOf(LightweightChartsAdapter);
 expect(CHART_ENGINE_DESCRIPTORS["lightweight-charts"].available).toBe(true);
 expect(appDescriptors["lightweight-charts"].available).toBe(false);
 expect(appDescriptors["arx-native"].available).toBe(true);
});
it("comparison never pretends to license the external Advanced Charts engine",()=>{
 expect(CHART_ENGINE_DESCRIPTORS["tradingview-advanced"].available).toBe(false);
 expect(()=>createChartEngineAdapter("tradingview-advanced")).toThrow(/not licensed/);
});
