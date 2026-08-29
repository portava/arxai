// ── Disagreement classes (capability #7) — pure ─────────────────────────────
//
// Extends council disagreement beyond direction/quality with FOUR further
// classes — timing, regime, cost, uncertainty — each with a per-class mapping
// to abstention or size reduction. REDUCE-ONLY CONTRACT:
//
//   * Every mapped action is NONE, REDUCE_SIZE, or ABSTAIN; the combined
//     sizeMultiplier is min(per-class multipliers) and can never exceed 1.
//   * Disagreement can never add size, add confidence, or upgrade an action.
//   * A class with fewer than two reporting agents is an honest
//     INSUFFICIENT_REPORTERS (multiplier 1, action NONE) — silence is not
//     agreement, but it is not evidence of disagreement either, and we never
//     fabricate a split from a single voice.
//
// The classifier consumes per-agent stance readings. Direction/quality reuse
// the exact semantics of disagreementScore.engine (directional weight
// imbalance; quality range); the four new classes are:
//
//   timing      — NOW vs WAIT/NO_WINDOW split among timing reporters
//   regime      — dissent from the modal regime label
//   cost        — dispersion of expected round-trip cost (in R)
//   uncertainty — dispersion of self-reported uncertainty (0..1)

export const DISAGREEMENT_CLASSES = [
  "direction",
  "quality",
  "timing",
  "regime",
  "cost",
  "uncertainty",
] as const;
export type DisagreementClass = (typeof DISAGREEMENT_CLASSES)[number];

/** One agent's stance. Every facet is optional — an agent only reports what
 *  it actually measured; missing facets simply do not count as reporters. */
export interface AgentStanceReading {
  agentId: string;
  direction?: "BUY" | "SELL" | "ABSTAIN";
  /** Conviction behind the direction, 0..100. Default 50 when direction given. */
  conviction?: number;
  quality?: number; // 0..100
  timing?: "NOW" | "WAIT" | "NO_WINDOW";
  regime?: string; // free label; compared by equality
  expectedCostR?: number; // expected round-trip cost in R units
  uncertainty01?: number; // self-reported uncertainty, 0..1
}

export type DisagreementAction = "NONE" | "REDUCE_SIZE" | "ABSTAIN";

export type ClassDisagreement =
  | {
      status: "MEASURED";
      class: DisagreementClass;
      score01: number;
      reporters: number;
      action: DisagreementAction;
      /** 0..1; 1 = no reduction. ABSTAIN → 0. Never above 1. */
      sizeMultiplier: number;
      reason: string;
    }
  | {
      status: "INSUFFICIENT_REPORTERS";
      class: DisagreementClass;
      score01: null;
      reporters: number;
      action: "NONE";
      sizeMultiplier: 1;
      reason: string;
    };

export interface DisagreementClassReport {
  classes: Record<DisagreementClass, ClassDisagreement>;
  /** min over per-class multipliers — the reduce-only combined verdict. */
  combinedSizeMultiplier: number;
  /** Most severe per-class action (ABSTAIN > REDUCE_SIZE > NONE). */
  combinedAction: DisagreementAction;
  reasons: string[];
}

/** Score at/above which a class demands full abstention. */
export const DISAGREEMENT_ABSTAIN_THRESHOLD = 0.8;
/** Score at/above which a class demands size reduction. */
export const DISAGREEMENT_REDUCE_THRESHOLD = 0.45;
/** Floor of the reduce-mode multiplier (reduction never silently → 0). */
export const DISAGREEMENT_MIN_REDUCE_MULTIPLIER = 0.25;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function mapToAction(cls: DisagreementClass, score01: number, reporters: number): ClassDisagreement {
  const s = clamp01(score01);
  if (s >= DISAGREEMENT_ABSTAIN_THRESHOLD) {
    return {
      status: "MEASURED", class: cls, score01: s, reporters,
      action: "ABSTAIN", sizeMultiplier: 0,
      reason: `${cls} disagreement ${s.toFixed(2)} ≥ ${DISAGREEMENT_ABSTAIN_THRESHOLD} → abstain`,
    };
  }
  if (s >= DISAGREEMENT_REDUCE_THRESHOLD) {
    const mult = Math.max(DISAGREEMENT_MIN_REDUCE_MULTIPLIER, 1 - s);
    return {
      status: "MEASURED", class: cls, score01: s, reporters,
      action: "REDUCE_SIZE", sizeMultiplier: mult,
      reason: `${cls} disagreement ${s.toFixed(2)} ≥ ${DISAGREEMENT_REDUCE_THRESHOLD} → size × ${mult.toFixed(2)}`,
    };
  }
  return {
    status: "MEASURED", class: cls, score01: s, reporters,
    action: "NONE", sizeMultiplier: 1,
    reason: `${cls} disagreement ${s.toFixed(2)} below reduce threshold`,
  };
}

function insufficient(cls: DisagreementClass, reporters: number): ClassDisagreement {
  return {
    status: "INSUFFICIENT_REPORTERS", class: cls, score01: null, reporters,
    action: "NONE", sizeMultiplier: 1,
    reason: `${cls}: ${reporters} reporter(s) < 2 — cannot measure disagreement`,
  };
}

/** Classify per-class disagreement over a set of agent stances. */
export function classifyDisagreement(stances: AgentStanceReading[]): DisagreementClassReport {
  const classes = {} as Record<DisagreementClass, ClassDisagreement>;

  // direction — conviction-weighted split, same shape as disagreementScore.
  {
    const dir = stances.filter((s) => s.direction === "BUY" || s.direction === "SELL");
    if (dir.length < 2) classes.direction = insufficient("direction", dir.length);
    else {
      const conv = (s: AgentStanceReading) =>
        Number.isFinite(s.conviction) ? Math.max(0, s.conviction as number) : 50;
      const buy = dir.filter((s) => s.direction === "BUY").reduce((a, s) => a + conv(s), 0);
      const sell = dir.filter((s) => s.direction === "SELL").reduce((a, s) => a + conv(s), 0);
      const total = buy + sell;
      const score = total > 0 ? (2 * Math.min(buy, sell)) / total : 0;
      classes.direction = mapToAction("direction", score, dir.length);
    }
  }

  // quality — dispersion of 0..100 quality scores.
  {
    const q = stances.filter((s) => Number.isFinite(s.quality));
    if (q.length < 2) classes.quality = insufficient("quality", q.length);
    else {
      const vals = q.map((s) => Math.max(0, Math.min(100, s.quality as number)));
      const score = (Math.max(...vals) - Math.min(...vals)) / 100;
      classes.quality = mapToAction("quality", score, q.length);
    }
  }

  // timing — NOW vs not-NOW split (WAIT and NO_WINDOW both oppose entry now).
  {
    const t = stances.filter((s) => s.timing !== undefined);
    if (t.length < 2) classes.timing = insufficient("timing", t.length);
    else {
      const now = t.filter((s) => s.timing === "NOW").length;
      const notNow = t.length - now;
      const score = t.length > 0 ? (2 * Math.min(now, notNow)) / t.length : 0;
      classes.timing = mapToAction("timing", score, t.length);
    }
  }

  // regime — dissent from the modal regime label.
  {
    const r = stances.filter((s) => typeof s.regime === "string" && s.regime.length > 0);
    if (r.length < 2) classes.regime = insufficient("regime", r.length);
    else {
      const counts = new Map<string, number>();
      for (const s of r) counts.set(s.regime as string, (counts.get(s.regime as string) ?? 0) + 1);
      const modal = Math.max(...counts.values());
      const score = 1 - modal / r.length; // 0 = unanimous, →1 as labels fragment
      classes.regime = mapToAction("regime", 2 * score, r.length); // 50/50 split of 2 labels → 1.0
    }
  }

  // cost — dispersion of expected cost estimates (in R), relative.
  {
    const c = stances.filter((s) => Number.isFinite(s.expectedCostR) && (s.expectedCostR as number) >= 0);
    if (c.length < 2) classes.cost = insufficient("cost", c.length);
    else {
      const vals = c.map((s) => s.expectedCostR as number);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const spread = Math.max(...vals) - Math.min(...vals);
      // Relative dispersion, with a 0.1R floor so near-zero means don't blow up.
      const score = clamp01(spread / Math.max(0.1, mean));
      classes.cost = mapToAction("cost", score, c.length);
    }
  }

  // uncertainty — dispersion of self-reported uncertainty.
  {
    const u = stances.filter((s) => Number.isFinite(s.uncertainty01));
    if (u.length < 2) classes.uncertainty = insufficient("uncertainty", u.length);
    else {
      const vals = u.map((s) => clamp01(s.uncertainty01 as number));
      const score = Math.max(...vals) - Math.min(...vals);
      classes.uncertainty = mapToAction("uncertainty", score, u.length);
    }
  }

  const all = DISAGREEMENT_CLASSES.map((c) => classes[c]);
  const combinedSizeMultiplier = Math.min(1, ...all.map((c) => c.sizeMultiplier));
  const combinedAction: DisagreementAction = all.some((c) => c.action === "ABSTAIN")
    ? "ABSTAIN"
    : all.some((c) => c.action === "REDUCE_SIZE")
      ? "REDUCE_SIZE"
      : "NONE";

  return {
    classes,
    combinedSizeMultiplier,
    combinedAction,
    reasons: all.map((c) => c.reason),
  };
}
