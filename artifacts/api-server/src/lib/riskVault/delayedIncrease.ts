// Capability #42 — delayed risk-ceiling increases (pure classification/planner).
//
// The asymmetry rule, in one place:
//   * TIGHTEN (less risk)  — applies instantly, no questions asked.
//   * LOOSEN  (more risk)  — queued behind a mandatory waiting period, and the
//     user must explicitly RE-CONFIRM after the period ends before anything
//     changes. Cancelling a queued increase is instant.
//
// Every risk_settings field is classified by an explicit per-field direction
// map. A field not in the map is NOT a risk ceiling and passes through
// untouched — but the map is exhaustive over the ceilings on purpose: adding a
// new ceiling without classifying it here fails the tests, not the user.
//
// Pure: no IO, no clock reads. Callers inject `now`.

/** Waiting period before a queued increase becomes confirmable. */
export const RISK_INCREASE_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

export type RiskDirection = "TIGHTEN" | "LOOSEN" | "NEUTRAL";

/** How each numeric ceiling loosens: "UP" = a higher value is riskier,
 *  "DOWN" = a lower value is riskier. */
const NUMERIC_LOOSEN_DIRECTION: Readonly<Record<string, "UP" | "DOWN">> = {
  maxDailyLossPct: "UP",
  maxWeeklyLossPct: "UP",
  maxTradesPerDay: "UP",
  maxOpenTrades: "UP",
  maxLotSize: "UP",
  riskPerTradePct: "UP",
  stopAfterLosingStreak: "UP",       // tolerating a longer losing streak = looser
  cooldownAfterLossMinutes: "DOWN",  // shorter cooldown = looser
  minConfidenceScore: "DOWN",        // lower confidence bar = looser
};

/** Boolean protections: the listed value is the PROTECTIVE one; flipping away
 *  from it is a loosening. */
const BOOLEAN_PROTECTIVE_VALUE: Readonly<Record<string, boolean>> = {
  disableDuringAbnormalVolatility: true,
  vol75ExtraConfidence: true,
  vol75SmallLot: true,
  us30BlockNews: true,
  stocksBlockEarnings: true,
  forexBlockEvents: true,
};

export const RISK_CEILING_FIELDS: readonly string[] = [
  ...Object.keys(NUMERIC_LOOSEN_DIRECTION),
  ...Object.keys(BOOLEAN_PROTECTIVE_VALUE),
];

export function classifyRiskSettingChange(
  field: string,
  from: number | boolean,
  to: number | boolean,
): RiskDirection {
  if (from === to) return "NEUTRAL";
  const numDir = NUMERIC_LOOSEN_DIRECTION[field];
  if (numDir !== undefined && typeof from === "number" && typeof to === "number") {
    if (numDir === "UP") return to > from ? "LOOSEN" : "TIGHTEN";
    return to < from ? "LOOSEN" : "TIGHTEN";
  }
  const protective = BOOLEAN_PROTECTIVE_VALUE[field];
  if (protective !== undefined && typeof from === "boolean" && typeof to === "boolean") {
    return to === protective ? "TIGHTEN" : "LOOSEN";
  }
  // Not a classified ceiling (or a type mismatch): not this engine's business.
  return "NEUTRAL";
}

export interface QueuedIncrease {
  field: string;
  valueKind: "number" | "boolean";
  currentValue: number;   // booleans stored as 0/1
  targetValue: number;
  effectiveAt: Date;
}

export interface RiskUpdatePlan {
  /** Tightenings + unclassified fields — write these immediately. */
  applyNow: Record<string, number | boolean>;
  /** Loosenings — persist as PENDING rows; nothing changes until re-confirmed. */
  queue: QueuedIncrease[];
  /** Human-readable per-field classification for the response envelope. */
  classifications: Array<{ field: string; direction: RiskDirection }>;
}

/**
 * Split a requested settings update into instant tightenings and queued
 * loosenings. Unclassified fields (e.g. riskMode label) apply instantly —
 * they are not ceilings. NEUTRAL (unchanged) fields are dropped entirely.
 */
export function planRiskSettingsUpdate(args: {
  current: Record<string, unknown>;
  requested: Record<string, unknown>;
  now: Date;
  delayMs?: number;
}): RiskUpdatePlan {
  const delay = args.delayMs ?? RISK_INCREASE_DELAY_MS;
  const applyNow: Record<string, number | boolean> = {};
  const queue: QueuedIncrease[] = [];
  const classifications: RiskUpdatePlan["classifications"] = [];

  for (const [field, toRaw] of Object.entries(args.requested)) {
    if (toRaw === undefined) continue;
    const fromRaw = args.current[field];
    const isCeiling = RISK_CEILING_FIELDS.includes(field);

    if (!isCeiling) {
      if (typeof toRaw === "number" || typeof toRaw === "boolean") applyNow[field] = toRaw;
      continue;
    }
    if (
      (typeof fromRaw !== "number" && typeof fromRaw !== "boolean") ||
      (typeof toRaw !== "number" && typeof toRaw !== "boolean")
    ) {
      continue; // unreadable current value: refuse to classify, change nothing (honest no-op)
    }
    const direction = classifyRiskSettingChange(field, fromRaw as number | boolean, toRaw as number | boolean);
    if (direction === "NEUTRAL") continue;
    classifications.push({ field, direction });
    if (direction === "TIGHTEN") {
      applyNow[field] = toRaw as number | boolean;
    } else {
      const valueKind = typeof toRaw === "boolean" ? "boolean" : "number";
      queue.push({
        field,
        valueKind,
        currentValue: typeof fromRaw === "boolean" ? (fromRaw ? 1 : 0) : (fromRaw as number),
        targetValue: typeof toRaw === "boolean" ? (toRaw ? 1 : 0) : (toRaw as number),
        effectiveAt: new Date(args.now.getTime() + delay),
      });
    }
  }
  return { applyNow, queue, classifications };
}

export type ConfirmVerdict =
  | { ok: true }
  | { ok: false; reason: "NOT_PENDING" | "WAITING_PERIOD_ACTIVE"; remainingMs?: number };

/** May a queued increase be confirmed now? Only PENDING rows past effectiveAt. */
export function canConfirmPendingIncrease(
  row: { status: string; effectiveAt: Date },
  now: Date,
): ConfirmVerdict {
  if (row.status !== "PENDING") return { ok: false, reason: "NOT_PENDING" };
  const remaining = row.effectiveAt.getTime() - now.getTime();
  if (remaining > 0) return { ok: false, reason: "WAITING_PERIOD_ACTIVE", remainingMs: remaining };
  return { ok: true };
}
