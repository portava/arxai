import {expect,it} from "vitest";
import {createChartEngineAdapter,DEFAULT_CHART_ENGINE_ID} from "./index";
import {NativeChartsAdapter} from "./nativeChartsAdapter";
it("ordinary chart consumers receive the ARX renderer without a QA override",()=>{
 expect(DEFAULT_CHART_ENGINE_ID).toBe("arx-native");
 expect(createChartEngineAdapter()).toBeInstanceOf(NativeChartsAdapter);
 expect(createChartEngineAdapter("arx-native")).toBeInstanceOf(NativeChartsAdapter);
});
it("ordinary app factory cannot select the retired legacy renderer",()=>{
 expect(()=>createChartEngineAdapter("lightweight-charts")).toThrow(/offline comparison/i);
});
it("ordinary app factory rejects unlicensed and unknown engines",()=>{
 expect(()=>createChartEngineAdapter("tradingview-advanced")).toThrow(/not licensed/i);
 expect(()=>createChartEngineAdapter("unknown" as never)).toThrow(/Unknown chart engine/);
});
