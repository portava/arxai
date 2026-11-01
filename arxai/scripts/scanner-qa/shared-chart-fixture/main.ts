// This isolated entry imports the actual dashboard App, routes, providers and
// styles. Only the observer is added; no component, data hook or API alias is
// substituted. Network isolation is installed by the browser setup beforehand.
import { LightweightChartsAdapter } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { installChartQaWitnesses } from "../../chart-qa/witness";
import { installVolumeProfileProbe } from "./volumeProfileProbe";

declare const __ARX_SCANNER_QA_BUILD_ID__: string;
declare const __ARX_VOLUME_PROFILE_PROBE__: boolean;
// Vite replaces this literal for each build. Unlike fetched metadata, it proves
// which fixture entry actually executed in this page and cannot be overwritten.
Object.defineProperty(window, "__arxScannerQaBuildId", {
  value: __ARX_SCANNER_QA_BUILD_ID__, writable: false, configurable: false,
});
if (__ARX_VOLUME_PROFILE_PROBE__) {
  installChartQaWitnesses(LightweightChartsAdapter);
  void import("../../../artifacts/trading-dashboard/src/index.css").then(()=>installVolumeProfileProbe(LightweightChartsAdapter));
}
else {
  installChartQaWitnesses(LightweightChartsAdapter);
  // Dynamic import guarantees the observer exists before the real app mounts.
  void import("../../../artifacts/trading-dashboard/src/main");
}
