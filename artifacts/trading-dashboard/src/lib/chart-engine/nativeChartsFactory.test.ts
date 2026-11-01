import {expect,it} from "vitest";
import {createChartEngineAdapter,DEFAULT_CHART_ENGINE_ID} from "./index";
import {NativeChartsAdapter} from "./nativeChartsAdapter";
it("explicit native selection uses the existing adapter without changing the deployed default",()=>{
 expect(DEFAULT_CHART_ENGINE_ID).toBe("lightweight-charts");
 expect(createChartEngineAdapter("arx-native")).toBeInstanceOf(NativeChartsAdapter);
});
