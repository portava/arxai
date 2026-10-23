// ═══════════════════════════════════════════════════════════════════════════
// Global State Replay
//
// Reconstructs global market state and Control Tower mode at the time of
// the decision. Flags inconsistencies (e.g. trade taken under HALT).
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplaySnapshot } from "./replay.types";

export const GlobalStateReplayReportSchema = z.object({
  globalState: z.string(),
  controlTowerMode: z.string(),
  consistent: z.boolean(),
  inconsistencies: z.array(z.string()),
});
export type GlobalStateReplayReport = z.infer<typeof GlobalStateReplayReportSchema>;

export function replayGlobalState(snapshot: ReplaySnapshot): GlobalStateReplayReport {
  const inconsistencies: string[] = [];
  const tookTrade = snapshot.decisionKind === "EXECUTED" || snapshot.decisionKind === "OVERRIDE";
  if (tookTrade && snapshot.controlTowerMode === "HALT") {
    inconsistencies.push("trade taken while Control Tower mode = HALT");
  }
  if (tookTrade && snapshot.controlTowerMode === "PAPER_ONLY" && !!snapshot.execution &&
      snapshot.execution.filledLotSize > 0 && !snapshot.execution.brokerReject) {
    inconsistencies.push("live execution recorded under PAPER_ONLY mode");
  }
  if (tookTrade && snapshot.globalState === "LOCKDOWN") {
    inconsistencies.push("trade taken under global LOCKDOWN");
  }
  return {
    globalState: snapshot.globalState,
    controlTowerMode: snapshot.controlTowerMode,
    consistent: inconsistencies.length === 0,
    inconsistencies,
  };
}
