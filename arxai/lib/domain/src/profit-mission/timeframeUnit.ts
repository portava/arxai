// Profit Mission — timeframe unit helpers (pure, deterministic, IO-free).
//
// Canonical conversions: 1 minute = 1 min, 1 hour = 60 min, 1 day = 1440 min,
// 1 week = 10080 min. All helpers are pure and deterministic.

import type { TimeframeUnit, TimeframeSpec } from "./types.js";

export const MINUTES_PER_UNIT: Record<TimeframeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};

/** Canonical quick-pick chips for the planner UI. */
export const TIMEFRAME_QUICK_PICKS: Array<{ label: string; amount: number; unit: TimeframeUnit }> = [
  { label: "5 min",   amount: 5,   unit: "minutes" },
  { label: "10 min",  amount: 10,  unit: "minutes" },
  { label: "20 min",  amount: 20,  unit: "minutes" },
  { label: "30 min",  amount: 30,  unit: "minutes" },
  { label: "1 hr",    amount: 1,   unit: "hours"   },
  { label: "2 hr",    amount: 2,   unit: "hours"   },
  { label: "5 hr",    amount: 5,   unit: "hours"   },
  { label: "10 hr",   amount: 10,  unit: "hours"   },
  { label: "1 day",   amount: 1,   unit: "days"    },
  { label: "3 days",  amount: 3,   unit: "days"    },
  { label: "1 week",  amount: 1,   unit: "weeks"   },
];

/** Convert a TimeframeSpec → total minutes. Returns 0 for invalid inputs. */
export function specToMinutes(amount: number, unit: TimeframeUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount * MINUTES_PER_UNIT[unit];
}

/** Build a human-readable label: "30 minutes", "1 hour", "3 days", "1 week". */
export function specToLabel(amount: number, unit: TimeframeUnit): string {
  const plural = amount !== 1;
  const word = {
    minutes: plural ? "minutes" : "minute",
    hours:   plural ? "hours"   : "hour",
    days:    plural ? "days"    : "day",
    weeks:   plural ? "weeks"   : "week",
  }[unit];
  return `${amount} ${word}`;
}

/** Minimal mission shape needed to render an honest timeframe display label. */
export interface MissionTimeframeDisplayInput {
  timeframeLabel?: string | null;
  timeframeAmount?: number | null;
  timeframeUnit?: TimeframeUnit | null;
  timeframeStart?: string | null;
  timeframeEnd?: string | null;
}

/**
 * Resolve the human-readable timeframe label for an existing mission.
 *
 * Precedence (honest, never fabricated):
 *  1. The persisted `timeframeLabel` (e.g. "30 minutes", "1 day").
 *  2. Reconstruct from persisted `timeframeAmount` + `timeframeUnit`.
 *  3. Legacy fallback: derive the most natural label from the
 *     `timeframeStart`/`timeframeEnd` span (these pre-date the unit fields).
 * Returns "—" only when nothing usable is present.
 */
export function resolveMissionTimeframeLabel(m: MissionTimeframeDisplayInput): string {
  const label = m.timeframeLabel?.trim();
  if (label) return label;
  if (m.timeframeAmount != null && m.timeframeAmount > 0 && m.timeframeUnit) {
    return specToLabel(m.timeframeAmount, m.timeframeUnit);
  }
  const startMs = m.timeframeStart ? new Date(m.timeframeStart).getTime() : NaN;
  const endMs = m.timeframeEnd ? new Date(m.timeframeEnd).getTime() : NaN;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    const minutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
    // Legacy rows pre-date the unit fields and were all created day-based, so a
    // ≥1-day span renders as whole days (matching the old display) rather than
    // being promoted to weeks. Sub-day spans get the most natural label.
    if (minutes >= MINUTES_PER_UNIT.days) {
      return specToLabel(Math.round(minutes / MINUTES_PER_UNIT.days), "days");
    }
    const spec = minutesToSpec(minutes);
    return specToLabel(spec.amount, spec.unit);
  }
  return "—";
}

/**
 * Decompose total minutes into the most natural (amount, unit) pair.
 * Prefers whole numbers: e.g. 60 → {1, hours}, 1440 → {1, days}.
 */
export function minutesToSpec(totalMinutes: number): TimeframeSpec {
  if (totalMinutes <= 0) return { amount: 1, unit: "minutes" };
  if (totalMinutes % MINUTES_PER_UNIT.weeks === 0)
    return { amount: totalMinutes / MINUTES_PER_UNIT.weeks, unit: "weeks" };
  if (totalMinutes % MINUTES_PER_UNIT.days === 0)
    return { amount: totalMinutes / MINUTES_PER_UNIT.days, unit: "days" };
  if (totalMinutes % MINUTES_PER_UNIT.hours === 0)
    return { amount: totalMinutes / MINUTES_PER_UNIT.hours, unit: "hours" };
  return { amount: totalMinutes, unit: "minutes" };
}
