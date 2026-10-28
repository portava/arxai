// This isolated entry imports the actual dashboard App, routes, providers and
// styles. Only the observer is added; no component, data hook or API alias is
// substituted. Network isolation is installed by the browser setup beforehand.
import { LightweightChartsAdapter } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { installChartQaWitnesses } from "../../chart-qa/witness";

installChartQaWitnesses(LightweightChartsAdapter);
// Dynamic import guarantees the observer exists before the real app mounts.
void import("../../../artifacts/trading-dashboard/src/main");
