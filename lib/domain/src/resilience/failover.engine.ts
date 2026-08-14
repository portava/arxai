import {
  type FailoverPlan, type HeartbeatVerdict, type ServiceId,
} from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Failover — for each (primary, [secondaries]) group, recommend the next
// healthy service when the primary is dead. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface FailoverGroup {
  primaryId: ServiceId;
  secondaryIds: ReadonlyArray<ServiceId>;
}
export interface FailoverInput {
  groups: ReadonlyArray<FailoverGroup>;
  heartbeats: ReadonlyArray<HeartbeatVerdict>;
}

export function planFailovers(input: FailoverInput): ReadonlyArray<FailoverPlan> {
  const aliveById = new Map(input.heartbeats.map((h) => [h.serviceId, h.alive]));
  return input.groups.map((g) => {
    const reasons: string[] = []; const blockers: string[] = [];
    const primaryAlive = aliveById.get(g.primaryId) ?? false;
    if (primaryAlive) {
      reasons.push(`primary ${g.primaryId} alive — no failover`);
      return { primaryId: g.primaryId, failoverToId: null, shouldFailover: false, reasons, blockers };
    }
    const next = g.secondaryIds.find((id) => aliveById.get(id));
    if (!next) {
      blockers.push(`primary ${g.primaryId} dead AND no healthy secondary`);
      reasons.push(`failover impossible — all candidates down`);
      return { primaryId: g.primaryId, failoverToId: null, shouldFailover: true, reasons, blockers };
    }
    reasons.push(`primary ${g.primaryId} dead → failover to ${next}`);
    return { primaryId: g.primaryId, failoverToId: next, shouldFailover: true, reasons, blockers };
  });
}
