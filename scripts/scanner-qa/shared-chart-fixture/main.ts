// This isolated entry imports the actual dashboard App, routes, providers and
// styles. Only the observer is added; no component, data hook or API alias is
// substituted. Network isolation is installed by the browser setup beforehand.
import { LightweightChartsAdapter } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { installChartQaWitnesses } from "../../chart-qa/witness";
import { installCandleTimeline } from "./candleTimeline";
import { installReactProfile } from "./reactProfile";
import { installFeedReconciliationProbe } from "./feedReconciliation";
import { installVolumeProfileProbe } from "./volumeProfileProbe";
import { installFlagLifecycleProbe } from "./flagLifecycleProbe";

declare const __ARX_SCANNER_QA_BUILD_ID__: string;
declare const __ARX_SCANNER_QA_REACT_PROFILE__: boolean;
declare const __ARX_FEED_RECONCILIATION__: boolean;
declare const __ARX_VOLUME_PROFILE_PROBE__: boolean;
declare const __ARX_FLAG_LIFECYCLE_PROBE__: boolean;
// Vite replaces this literal for each build. Unlike fetched metadata, it proves
// which fixture entry actually executed in this page and cannot be overwritten.
Object.defineProperty(window, "__arxScannerQaBuildId", {
  value: __ARX_SCANNER_QA_BUILD_ID__, writable: false, configurable: false,
});
if (__ARX_FLAG_LIFECYCLE_PROBE__) {
  void import("../../../artifacts/trading-dashboard/src/index.css").then(()=>installFlagLifecycleProbe(LightweightChartsAdapter));
}
else if (__ARX_VOLUME_PROFILE_PROBE__) {
  installChartQaWitnesses(LightweightChartsAdapter);
  void import("../../../artifacts/trading-dashboard/src/index.css").then(()=>installVolumeProfileProbe(LightweightChartsAdapter));
}
else if (__ARX_FEED_RECONCILIATION__) {
  // Keep the normal Scanner fixture's stylesheet loading order unchanged.
  void import("../../../artifacts/trading-dashboard/src/index.css").then(()=>installFeedReconciliationProbe(LightweightChartsAdapter));
}
else {
  installChartQaWitnesses(LightweightChartsAdapter);
  if(__ARX_SCANNER_QA_REACT_PROFILE__) { installReactProfile(); installCandleTimeline(LightweightChartsAdapter); }
  // Dynamic import guarantees the observer exists before the real app mounts.
  void import("../../../artifacts/trading-dashboard/src/main");
}
