import {
  type DegradedModePlan, type HeartbeatVerdict, type DataIntegrityVerdict,
} from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Degraded Mode — when partial failures are detected (some services down,
// data integrity issues), disable nonessential features rather than full
// shutdown. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface DegradedInput {
  heartbeats: ReadonlyArray<HeartbeatVerdict>;
  dataIntegrity: DataIntegrityVerdict;
  nonEssentialFeatures: ReadonlyArray<string>;
}

export function planDegradedMode(input: DegradedInput): DegradedModePlan {
  const reasons: string[] = [];
  const dead = input.heartbeats.filter((h) => !h.alive);
  const deadCount = dead.length;
  const dataBad  = !input.dataIntegrity.trustworthy && input.dataIntegrity.issue !== "STALE_FEED";

  let active = false;
  const disabledFeatures: string[] = [];
  if (deadCount > 0 || dataBad) {
    active = true;
    disabledFeatures.push(...input.nonEssentialFeatures);
    reasons.push(`degraded: ${deadCount} dead service(s), data ${input.dataIntegrity.issue}`);
  } else {
    reasons.push(`all healthy — degraded inactive`);
  }
  return { active, disabledFeatures, reasons };
}
