// ═══════════════════════════════════════════════════════════════════════════
// Retention policy — classifies each event into HOT / WARM / ARCHIVED tiers
// based on age. Pure: no IO, no deletion. Callers (Phase 3 maintenance job)
// can use the classification to move/age events without ever erasing them.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent } from "./eventSchema.types.js";

export type RetentionTier = "HOT" | "WARM" | "ARCHIVED";

export interface RetentionPolicy {
  hotMaxAgeMs: number;     // events younger than this → HOT
  warmMaxAgeMs: number;    // events younger than this → WARM, else ARCHIVED
  /** Optional override: these event types are always promoted to HOT. */
  alwaysHotTypes?: ReadonlyArray<string>;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  hotMaxAgeMs:  7 * 24 * 60 * 60 * 1000,   // 7 days
  warmMaxAgeMs: 90 * 24 * 60 * 60 * 1000,  // 90 days
  alwaysHotTypes: [
    "KILL_SWITCH", "KILL_SWITCH_ENGAGED", "KILL_SWITCH_RESET", "VAULT_CORRECTION",
  ],
};

export interface RetentionPlanRow {
  eventId: string;
  tier: RetentionTier;
  ageMs: number;
}

export interface RetentionPlan {
  generatedAtIso: string;
  countsByTier: Record<RetentionTier, number>;
  rows: RetentionPlanRow[];
}

export function classifyRetention(
  events: ReadonlyArray<AuditEvent>,
  nowMs: number,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionPlan {
  const rows: RetentionPlanRow[] = [];
  const counts: Record<RetentionTier, number> = { HOT: 0, WARM: 0, ARCHIVED: 0 };
  const alwaysHot = new Set(policy.alwaysHotTypes ?? []);

  for (const e of events) {
    const ts = Date.parse(e.timestamp);
    const age = Number.isNaN(ts) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - ts);
    let tier: RetentionTier;
    if (alwaysHot.has(e.eventType) || age <= policy.hotMaxAgeMs) tier = "HOT";
    else if (age <= policy.warmMaxAgeMs) tier = "WARM";
    else tier = "ARCHIVED";
    rows.push({ eventId: e.eventId, tier, ageMs: age === Infinity ? -1 : age });
    counts[tier]++;
  }
  return { generatedAtIso: new Date(nowMs).toISOString(), countsByTier: counts, rows };
}
