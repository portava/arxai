// Chart Brain v2 — Task 2, Engine 6: trade readiness gates + quality label.
//
// Scores the chart's readiness for a trade from the other engine reads + the
// feed quality, across explicit gates (data clean, levels mapped, regime
// quality, entry timing, R:R, invalidation clarity, timeframe agreement, signal
// freshness). Produces a 0-100 score and an A+/A/B/C/D/F label.
//
// MANDATORY DOWNGRADES (honesty over optimism): bad/unusable data, a late entry
// (price already extended from the level), or any high-severity contradiction is
// a VETO — the score is floored and the label cannot exceed the veto cap.
// Momentum alone can never earn an A: without level + timeframe + invalidation
// support the label is capped at C.

import { clamp, round } from "./chartMath.js";
import type {
  ChartCandleIntentRead,
  ChartEvidenceRead,
  ChartLevelsRead,
  ChartQualityLabel,
  ChartReadinessGate,
  ChartReadinessRead,
  ChartTimeframeAgreement,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";
import type { ChartSetupRead } from "./setupLifecycle.js";

export interface ReadinessInputs {
  feedUsable: boolean; // aiUsable / clean
  feedStale: boolean;
  trend: ChartTrendRead;
  levels: ChartLevelsRead;
  candleIntent: ChartCandleIntentRead;
  setup: ChartSetupRead;
  tfAgreement: ChartTimeframeAgreement;
  evidence: ChartEvidenceRead;
}

function labelFor(score: number): ChartQualityLabel {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 68) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function capLabel(label: ChartQualityLabel, cap: ChartQualityLabel): ChartQualityLabel {
  const order: ChartQualityLabel[] = ["F", "D", "C", "B", "A", "A+"];
  const li = order.indexOf(label);
  const ci = order.indexOf(cap);
  if (li < 0 || ci < 0) return label;
  return li > ci ? cap : label;
}

export function computeTradeReadiness(input: ReadinessInputs): ChartReadinessRead {
  const { feedUsable, feedStale, trend, levels, candleIntent, setup, tfAgreement, evidence } =
    input;

  if (!trend.populated || !levels.populated) {
    return {
      populated: false,
      score: null,
      quality: "unrated",
      gates: [],
      vetoed: false,
      vetoReason: null,
      note: "Insufficient data to rate trade readiness.",
    };
  }

  const gates: ChartReadinessGate[] = [];
  const add = (
    key: string,
    label: string,
    passed: boolean,
    score: number,
    detail: string,
  ) => gates.push({ key, label, passed, score: round(clamp(score, 0, score)), detail });

  // 1. Data clean.
  add(
    "data_clean",
    "Data clean",
    feedUsable && !feedStale,
    feedUsable && !feedStale ? 14 : 0,
    feedUsable ? (feedStale ? "Feed is stale." : "Feed is clean.") : "Feed not AI-usable.",
  );

  // 2. Levels mapped (with an actionable level near price).
  const actionLevel =
    setup.direction === "bullish"
      ? levels.nearestSupport
      : setup.direction === "bearish"
        ? levels.nearestResistance
        : null;
  const levelsOk = levels.levels.length >= 2 && !!actionLevel;
  add(
    "levels_mapped",
    "Levels mapped",
    levelsOk,
    levelsOk ? 14 : levels.levels.length > 0 ? 6 : 0,
    levelsOk ? "Actionable level identified." : "No clear actionable level.",
  );

  // 3. Regime quality.
  const regimeOk = trend.regime === "trending";
  add(
    "regime_quality",
    "Regime quality",
    regimeOk,
    regimeOk ? 14 : trend.regime === "volatile" ? 4 : trend.regime === "ranging" ? 6 : 2,
    `Regime is ${trend.regime}.`,
  );

  // 4. Entry timing (setup stage).
  const timingOk = setup.stage === "entry_valid" || setup.stage === "trigger";
  const late =
    setup.stage === "stale" ||
    (setup.decayScore != null && setup.decayScore >= 80) ||
    (setup.ageBars == null && setup.stage === "idea_forming");
  add(
    "entry_timing",
    "Entry timing",
    timingOk,
    timingOk ? 14 : setup.stage === "confirmation_needed" ? 7 : setup.stage === "watchlist" ? 4 : 0,
    `Setup stage ${setup.stage}.`,
  );

  // 5. Risk:reward — distance to barrier vs distance to invalidation.
  let rrOk = false;
  let rrDetail = "Cannot compute R:R without level + invalidation.";
  let rrScore = 0;
  const barrier =
    setup.direction === "bullish" ? levels.nearestResistance : levels.nearestSupport;
  if (actionLevel && barrier && setup.invalidationPrice != null) {
    const entry = actionLevel.price;
    const risk = Math.abs(entry - setup.invalidationPrice);
    const reward = Math.abs(barrier.price - entry);
    if (risk > 0) {
      const rr = reward / risk;
      rrOk = rr >= 1.5;
      rrScore = clamp(rr >= 2 ? 14 : rr >= 1.5 ? 10 : rr >= 1 ? 5 : 0);
      rrDetail = `Reward:risk ≈ ${round(rr, 2)} (target ${barrier.price}, stop ${setup.invalidationPrice}).`;
    }
  }
  add("risk_reward", "Risk:reward", rrOk, rrScore, rrDetail);

  // 6. Invalidation clarity.
  const invalidationOk = setup.invalidationPrice != null;
  add(
    "invalidation_clarity",
    "Invalidation clarity",
    invalidationOk,
    invalidationOk ? 10 : 0,
    setup.invalidationCondition ?? "No clear invalidation.",
  );

  // 7. Timeframe agreement.
  const tfOk =
    tfAgreement.populated &&
    tfAgreement.agreementScore != null &&
    tfAgreement.agreementScore >= 60 &&
    tfAgreement.alignedDirection === setup.direction;
  add(
    "timeframe_agreement",
    "Timeframe agreement",
    tfOk,
    tfOk ? 12 : tfAgreement.populated && (tfAgreement.agreementScore ?? 0) >= 40 ? 5 : 0,
    tfAgreement.populated
      ? `Agreement ${tfAgreement.agreementScore ?? 0} (${tfAgreement.alignedDirection}).`
      : "Timeframe agreement not yet computed.",
  );

  // 8. Signal freshness.
  const freshOk = setup.freshness != null && setup.freshness >= 50;
  add(
    "signal_freshness",
    "Signal freshness",
    freshOk,
    freshOk ? 8 : setup.freshness != null ? 3 : 0,
    setup.freshness != null ? `Freshness ${setup.freshness}.` : "No active setup to age.",
  );

  let score = clamp(gates.reduce((a, g) => a + g.score, 0));

  // ── Mandatory downgrades / vetoes ───────────────────────────────────────
  let vetoed = false;
  let vetoReason: string | null = null;
  let labelCap: ChartQualityLabel = "A+";

  if (!feedUsable) {
    vetoed = true;
    vetoReason = "Feed is not AI-usable — no trade rating possible.";
    score = Math.min(score, 25);
    labelCap = "F";
  } else if (feedStale) {
    vetoed = true;
    vetoReason = "Feed is stale.";
    score = Math.min(score, 40);
    labelCap = capLabel(labelCap, "D");
  }

  if (late) {
    vetoed = true;
    vetoReason = vetoReason ?? "Entry is late — setup is stale or fully decayed.";
    score = Math.min(score, 45);
    labelCap = capLabel(labelCap, "D");
  }

  const highContradiction = evidence.contradictions.find((c) => c.severity === "high");
  if (highContradiction) {
    vetoed = true;
    vetoReason = vetoReason ?? highContradiction.text;
    score = Math.min(score, 45);
    labelCap = capLabel(labelCap, "D");
  }

  if (setup.stage === "invalid") {
    vetoed = true;
    vetoReason = vetoReason ?? "Setup is invalid.";
    score = Math.min(score, 30);
    labelCap = capLabel(labelCap, "F");
  }

  // Momentum alone can never earn an A: needs level + TF + invalidation support.
  const structuralSupport = levelsOk && tfOk && invalidationOk && rrOk;
  if (!structuralSupport) {
    labelCap = capLabel(labelCap, "C");
  }

  let quality = labelFor(score);
  quality = capLabel(quality, labelCap);
  if (!input.candleIntent.populated && quality !== "F") {
    // No candle read at all — cannot bless an entry; cap at C.
    quality = capLabel(quality, "C");
  }

  return {
    populated: true,
    score: round(score),
    quality,
    gates,
    vetoed,
    vetoReason,
    note: vetoed
      ? `Readiness ${round(score)} (${quality}) — downgraded: ${vetoReason}`
      : `Readiness ${round(score)} (${quality}).`,
  };
}
