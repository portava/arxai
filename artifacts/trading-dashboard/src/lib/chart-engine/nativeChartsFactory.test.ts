import {expect,it} from "vitest";
import {createChartEngineAdapter,DEFAULT_CHART_ENGINE_ID} from "./index";
import {NativeChartsAdapter} from "./nativeChartsAdapter";
it("ordinary chart consumers receive the ARX renderer without a QA override",()=>{
 expect(DEFAULT_CHART_ENGINE_ID).toBe("arx-native");
 expect(createChartEngineAdapter()).toBeInstanceOf(NativeChartsAdapter);
 expect(createChartEngineAdapter("arx-native")).toBeInstanceOf(NativeChartsAdapter);
});
