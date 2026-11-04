/**
 * Trading School — Practice Lab math. PURE functions only (no React, no
 * storage, no network) so every grade a lab shows can be unit-tested and is
 * fully deterministic. Education only: these grade practice placements against
 * fixed, made-up scenarios; they say nothing about whether a real trade wins.
 */

export type Direction = "long" | "short";

/* ------------------------------------------------------------------ */
/* Scenario quiz scoring                                              */
/* ------------------------------------------------------------------ */

export interface QuizScore {
  correct: number;
  total: number;
  /** 0..1 */
  pct: number;
}

/** Score a scenario quiz: answers[i] is the chosen option index for scenario i (or undefined). */
export function scoreScenarioQuiz(
  scenarios: ReadonlyArray<{ answerIndex: number }>,
  answers: ReadonlyArray<number | undefined>,
): QuizScore {
  const total = scenarios.length;
  const correct = scenarios.reduce((n, s, i) => (answers[i] === s.answerIndex ? n + 1 : n), 0);
  return { correct, total, pct: total > 0 ? correct / total : 0 };
}

/** Simple moving average; the first (period - 1) entries are null. */
export function sma(values: ReadonlyArray<number>, period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry / Stop / Target placement                                    */
/* ------------------------------------------------------------------ */

export interface Placement {
  entry: number;
  stop: number;
  target: number;
}

export interface PlacementMetrics {
  riskPips: number;
  rewardPips: number;
  /** reward / risk; 0 when risk is 0 */
  rr: number;
  /** stop and target are on the correct sides of entry for the direction */
  ordered: boolean;
}

function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function calcPlacement(direction: Direction, p: Placement, pipSize: number): PlacementMetrics {
  const riskPips = roundTo(Math.abs(p.entry - p.stop) / pipSize, 1);
  const rewardPips = roundTo(Math.abs(p.target - p.entry) / pipSize, 1);
  const ordered = direction === "long"
    ? p.stop < p.entry && p.entry < p.target
    : p.stop > p.entry && p.entry > p.target;
  const rr = riskPips > 0 ? roundTo(rewardPips / riskPips, 2) : 0;
  return { riskPips, rewardPips, rr, ordered };
}

export interface PlacementScenarioRules {
  direction: Direction;
  pipSize: number;
  /** the swing the stop must sit beyond (swing low for longs, swing high for shorts) */
  swingPrice: number;
  /** price the entry should be near (e.g. the last close / pullback zone) */
  idealEntry: number;
  entryTolerancePips: number;
  /** minimum reward:risk */
  minRR: number;
  /** a stop further than this beyond the swing is flagged as needlessly wide */
  maxStopBeyondSwingPips: number;
}

export interface GradeCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface PlacementGrade {
  metrics: PlacementMetrics;
  checks: GradeCheck[];
  passed: boolean;
}

export function gradePlacement(rules: PlacementScenarioRules, p: Placement): PlacementGrade {
  const { direction, pipSize } = rules;
  const m = calcPlacement(direction, p, pipSize);
  const isLong = direction === "long";
  const checks: GradeCheck[] = [];

  checks.push({
    id: "order",
    label: isLong ? "Stop below entry, target above" : "Stop above entry, target below",
    pass: m.ordered,
    detail: m.ordered
      ? "The lines are on the right sides for this direction."
      : isLong
        ? "For a buy, the stop goes under the entry and the target goes above it."
        : "For a sell, the stop goes above the entry and the target goes under it.",
  });

  const entryOffPips = roundTo(Math.abs(p.entry - rules.idealEntry) / pipSize, 1);
  const entryOk = entryOffPips <= rules.entryTolerancePips;
  checks.push({
    id: "entry",
    label: "Entry near the setup",
    pass: entryOk,
    detail: entryOk
      ? `Entry is ${entryOffPips} pips from the setup price — close enough.`
      : `Entry is ${entryOffPips} pips from the setup price. Keep it within ${rules.entryTolerancePips} pips so you are trading this setup, not a different one.`,
  });

  const beyond = isLong ? p.stop < rules.swingPrice : p.stop > rules.swingPrice;
  const beyondPips = roundTo((isLong ? rules.swingPrice - p.stop : p.stop - rules.swingPrice) / pipSize, 1);
  const tooWide = beyond && beyondPips > rules.maxStopBeyondSwingPips;
  checks.push({
    id: "stop",
    label: isLong ? "Stop beyond the swing low" : "Stop beyond the swing high",
    pass: beyond && !tooWide,
    detail: !beyond
      ? `The stop is inside the swing ${isLong ? "low" : "high"}. A normal retest of that swing could stop you out before the idea is actually wrong.`
      : tooWide
        ? `The stop is ${beyondPips} pips past the swing — wider than needed (aim for within ${rules.maxStopBeyondSwingPips}). A wide stop shrinks your position size and R:R for no extra protection.`
        : `The stop sits ${beyondPips} pips past the swing — protected by structure.`,
  });

  const rrOk = m.ordered && m.rr >= rules.minRR;
  checks.push({
    id: "rr",
    label: `Reward at least ${rules.minRR}× the risk`,
    pass: rrOk,
    detail: rrOk
      ? `R:R is 1 : ${m.rr.toFixed(2)} — meets the 1 : ${rules.minRR} target.`
      : `R:R is 1 : ${m.rr.toFixed(2)}. Move the target further or tighten the entry so reward is at least ${rules.minRR}× the risk.`,
  });

  return { metrics: m, checks, passed: checks.every((c) => c.pass) };
}

/* ------------------------------------------------------------------ */
/* Support / Resistance zone grading                                  */
/* ------------------------------------------------------------------ */

export interface TargetZone {
  id: string;
  label: string;
  price: number;
}

export interface ZoneGrade {
  hitIds: string[];
  missedIds: string[];
  /** placed levels that did not match any target zone */
  extras: number[];
  /** hits / targets, 0..1 */
  pct: number;
  passed: boolean;
}

/**
 * A target zone counts as hit when any placed level is within `tolerance`
 * (in price units, inclusive) of the zone price. Each placed level can only
 * satisfy one zone (the nearest unclaimed one). Passed = every zone hit and at
 * most `maxExtras` stray levels.
 */
export function gradeZones(
  placed: ReadonlyArray<number>,
  targets: ReadonlyArray<TargetZone>,
  tolerance: number,
  maxExtras = 1,
): ZoneGrade {
  const eps = 1e-9;
  const claimed = new Set<number>();
  const hitIds: string[] = [];
  const missedIds: string[] = [];
  for (const t of targets) {
    let best = -1;
    let bestDist = Infinity;
    placed.forEach((lvl, i) => {
      if (claimed.has(i)) return;
      const d = Math.abs(lvl - t.price);
      if (d <= tolerance + eps && d < bestDist) { best = i; bestDist = d; }
    });
    if (best >= 0) { claimed.add(best); hitIds.push(t.id); } else missedIds.push(t.id);
  }
  const extras = placed.filter((_, i) => !claimed.has(i));
  const pct = targets.length > 0 ? hitIds.length / targets.length : 0;
  return { hitIds, missedIds, extras, pct, passed: missedIds.length === 0 && extras.length <= maxExtras };
}

/* ------------------------------------------------------------------ */
/* Trade plan checklist rubric                                         */
/* ------------------------------------------------------------------ */

export interface TradePlanInput {
  market: string;
  direction: Direction | "";
  reason: string;
  entry: string;
  stop: string;
  target: string;
  riskPct: string;
  invalidation: string;
  sessionChecked: boolean;
  newsChecked: boolean;
}

export const EMPTY_TRADE_PLAN: TradePlanInput = {
  market: "", direction: "", reason: "", entry: "", stop: "", target: "",
  riskPct: "", invalidation: "", sessionChecked: false, newsChecked: false,
};

export interface RubricItem {
  id: string;
  label: string;
  points: number;
  max: number;
  feedback: string;
}

export interface TradePlanScore {
  score: number; // 0..100
  items: RubricItem[];
  rr: number | null;
}

function num(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic 0–100 checklist score for a written trade plan. */
export function scoreTradePlan(plan: TradePlanInput): TradePlanScore {
  const items: RubricItem[] = [];
  const add = (id: string, label: string, points: number, max: number, feedback: string) =>
    items.push({ id, label, points, max, feedback });

  add("market", "Market chosen", plan.market ? 5 : 0, 5,
    plan.market ? "You named the market." : "Pick the market you are planning.");
  add("direction", "Direction chosen", plan.direction ? 5 : 0, 5,
    plan.direction ? "Direction is clear." : "Choose buy (long) or sell (short).");

  const reasonLen = plan.reason.trim().length;
  add("reason", "Reason for the trade", reasonLen >= 40 ? 10 : reasonLen >= 15 ? 5 : 0, 10,
    reasonLen >= 40 ? "Clear reason written down."
      : reasonLen >= 15 ? "Good start — add what you see on the chart (structure, level, trend) in a full sentence."
      : "Write why this trade exists: the level, the trend, the trigger.");

  const entry = num(plan.entry);
  const stop = num(plan.stop);
  const target = num(plan.target);
  const levelsPresent = [entry, stop, target].filter((v) => v !== null).length;
  add("levels", "Entry, stop and target set", levelsPresent * 5, 15,
    levelsPresent === 3 ? "All three prices are set." : `${3 - levelsPresent} of entry / stop / target missing. A plan without a stop is not a plan.`);

  let ordered = false;
  let rr: number | null = null;
  if (entry !== null && stop !== null && target !== null && plan.direction) {
    ordered = plan.direction === "long" ? stop < entry && entry < target : stop > entry && entry > target;
    const risk = Math.abs(entry - stop);
    rr = risk > 0 ? Math.abs(target - entry) / risk : null;
  }
  add("consistency", "Levels match the direction", ordered ? 15 : 0, 15,
    ordered ? "Stop and target are on the correct sides of entry."
      : plan.direction === "short" ? "For a sell: stop above entry, target below."
      : plan.direction === "long" ? "For a buy: stop below entry, target above."
      : "Set a direction and all three prices to check this.");

  const rrPts = ordered && rr !== null ? (rr >= 2 ? 15 : rr >= 1.5 ? 10 : rr >= 1 ? 5 : 0) : 0;
  add("rr", "Reward-to-risk", rrPts, 15,
    !ordered || rr === null ? "R:R can be checked once the levels line up."
      : rr >= 2 ? `R:R about 1 : ${rr.toFixed(2)} — solid.`
      : `R:R about 1 : ${rr.toFixed(2)}. Aim for at least 1 : 2 so winners pay for losers.`);

  const risk = num(plan.riskPct);
  const riskPts = risk === null || risk <= 0 ? 0 : risk <= 1 ? 15 : risk <= 2 ? 12 : risk <= 3 ? 6 : 0;
  add("risk", "Risk per trade", riskPts, 15,
    risk === null || risk <= 0 ? "Set how much of the account you will risk, in %."
      : risk <= 1 ? "Conservative risk — good for practice."
      : risk <= 2 ? "Acceptable, but 1% or less is kinder while you learn."
      : risk <= 3 ? "On the high side for a beginner. Consider 1–2%."
      : "Too much risk for one trade. A short losing streak would do real damage.");

  const invLen = plan.invalidation.trim().length;
  add("invalidation", "Invalidation written", invLen >= 10 ? 10 : 0, 10,
    invLen >= 10 ? "You know what proves the idea wrong." : "Write what would prove this idea wrong (e.g. a close below the swing low).");

  add("session", "Session checked", plan.sessionChecked ? 5 : 0, 5,
    plan.sessionChecked ? "Session checked." : "Check the market is in an active session.");
  add("news", "News checked", plan.newsChecked ? 5 : 0, 5,
    plan.newsChecked ? "News calendar checked." : "Check for high-impact news before entering.");

  const score = items.reduce((s, i) => s + i.points, 0);
  return { score, items, rr };
}
