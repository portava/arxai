// Whether the chart-truth gate has verified a Chart Intelligence read — the
// same conditions the server uses to cap the decision summary and Ruby uses
// for a directional read: Chart Truth >= 75, feed not stale, broker mirror not
// failed, and a live feed. Client surfaces may only DOWNGRADE with this (cap a
// "ready", withhold a consensus stance), never upgrade a server claim.

import type { ChartIntelligenceResponse } from "@workspace/api-client-react";

type ChartState = ChartIntelligenceResponse["state"];

export interface ChartReadVerification {
  verified: boolean;
  /** Plain-English reasons the read is not verified (empty when verified). */
  reasons: string[];
}

export function chartReadVerification(state: ChartState): ChartReadVerification {
  const gate = (state as { gateOutput?: ChartState["gateOutput"] | null }).gateOutput ?? null;
  const reasons: string[] = [];
  if (!gate) {
    reasons.push("the chart truth check could not be loaded");
  } else {
    if (!gate.confidentReadAllowed) reasons.push(`Chart Truth ${gate.chartTruthScore}/100 (needs 75)`);
    if (!gate.autonomousChartActionAllowed) reasons.push("the feed is stale");
    if (!gate.tradeConfirmationAllowed) reasons.push("the broker-mirror check failed");
  }
  if (state.truthState?.isLive !== true) reasons.push("the feed is not live right now");
  return { verified: reasons.length === 0, reasons };
}
