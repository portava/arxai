// This isolated entry imports the actual dashboard App, routes, providers and
// styles. The optional native mode changes the default adapter in this QA
// bundle only. Components, data hooks and API aliases are not substituted. Network isolation is installed by the browser setup beforehand.
import { LightweightChartsAdapter } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { installChartQaWitnesses } from "../../chart-qa/witness";
import { installCandleTimeline } from "./candleTimeline";
import { installReactProfile } from "./reactProfile";
import { installFeedReconciliationProbe } from "./feedReconciliation";
import { installVolumeProfileProbe } from "./volumeProfileProbe";
import { installFlagLifecycleProbe } from "./flagLifecycleProbe";
import { DEFAULT_CHART_ENGINE_ID } from "../../../artifacts/trading-dashboard/src/lib/chart-engine";
import { NativeChartsAdapter } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/nativeChartsAdapter";
import { installNativeChartWitness } from "./nativeWitness";

declare const __ARX_SCANNER_QA_BUILD_ID__: string;
declare const __ARX_SCANNER_QA_REACT_PROFILE__: boolean;
declare const __ARX_FEED_RECONCILIATION__: boolean;
declare const __ARX_VOLUME_PROFILE_PROBE__: boolean;
declare const __ARX_FLAG_LIFECYCLE_PROBE__: boolean;
declare const __ARX_NATIVE_ENGINE__: boolean;
// Vite replaces this literal for each build. Unlike fetched metadata, it proves
// which fixture entry actually executed in this page and cannot be overwritten.
Object.defineProperty(window, "__arxScannerQaBuildId", {
  value: __ARX_SCANNER_QA_BUILD_ID__, writable: false, configurable: false,
});
Object.defineProperty(window, "__arxExecutedDefaultEngineId", { value: DEFAULT_CHART_ENGINE_ID, writable: false, configurable: false });
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
  if (__ARX_NATIVE_ENGINE__) installNativeChartWitness(NativeChartsAdapter);
  else installChartQaWitnesses(LightweightChartsAdapter);
  if(__ARX_SCANNER_QA_REACT_PROFILE__) { installReactProfile(); installCandleTimeline(LightweightChartsAdapter); }
  // Dynamic import guarantees the observer exists before the real app mounts.
  if (__ARX_NATIVE_ENGINE__ && location.pathname === '/position-mini-qa') {
    void import('./positionMiniFixture').then(module=>module.mountPositionMiniFixture());
  } else void import("../../../artifacts/trading-dashboard/src/main");
}
