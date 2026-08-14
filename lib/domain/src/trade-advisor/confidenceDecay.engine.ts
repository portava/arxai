import {
  type ConfidenceDecayReport, type DecayDriver, type TradeSnapshot,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// computeConfidenceDecay
//
// Pure: estimates how much the entry-time conviction has eroded since open,
// from 4 independent drivers. The derived "current confidence" is just
// originalConfidence − decay, bounded [0..100]. When a live re-evaluation
// is available, that confidence is blended in (caller's live signal beats
// our estimate when present).
export function computeConfidenceDecay(snap: TradeSnapshot): ConfidenceDecayReport {
  const T = TRADE_ADVISOR_THRESHOLDS.decay;
  const reasons: string[] = [];
  const contributions = { TIME: 0, MAE_PRESSURE: 0, AGENT_REVERSAL: 0, CONDITION_DRIFT: 0 };

  // ── Driver 1: Time decay ────────────────────────────────────────────────
  if (snap.entry.expectedHoldSeconds > 0
      && snap.trade.ageSeconds > snap.entry.expectedHoldSeconds) {
    const overstayHours = (snap.trade.ageSeconds - snap.entry.expectedHoldSeconds) / 3600;
    const dec = Math.min(overstayHours * T.timeDecayPerOverstayHr, 50);
    contributions.TIME = dec;
    if (dec > 0) reasons.push(`-${dec.toFixed(0)} from time overstay (${overstayHours.toFixed(2)}h past expected)`);
  }

  // ── Driver 2: MAE pressure ──────────────────────────────────────────────
  // Deeper MAE = the market argued against the trade, even if it bounced.
  const maeMag = Math.abs(snap.extremes.maxAdverseExcursionR);
  if (maeMag > 0.25) {
    const dec = Math.min(maeMag * T.maeDecayPerR, 60);
    contributions.MAE_PRESSURE = dec;
    reasons.push(`-${dec.toFixed(0)} from MAE pressure (${maeMag.toFixed(2)}R adverse excursion)`);
  }

  // ── Driver 3: Agent reversal — sharp ────────────────────────────────────
  if (snap.live.agentDirectionReversed) {
    contributions.AGENT_REVERSAL = T.agentReversalDecay;
    reasons.push(`-${T.agentReversalDecay} from live agent reversal (opposite direction now favored)`);
  } else if (snap.live.currentConfidence !== null
             && snap.live.currentConfidence < snap.entry.originalConfidence - 20) {
    // Same direction but materially less confident
    const drop = snap.entry.originalConfidence - snap.live.currentConfidence;
    contributions.AGENT_REVERSAL = Math.min(drop, 40);
    reasons.push(`-${contributions.AGENT_REVERSAL.toFixed(0)} from live confidence drop (was ${snap.entry.originalConfidence}, now ${snap.live.currentConfidence})`);
  }

  // ── Driver 4: Condition drift ───────────────────────────────────────────
  if (snap.market.volatilityAtEntry !== null && snap.market.volatilityNow !== null
      && snap.market.volatilityAtEntry > 0) {
    const ratio = snap.market.volatilityNow / snap.market.volatilityAtEntry;
    if (ratio > 1.5 || ratio < 0.5) {
      contributions.CONDITION_DRIFT = T.conditionDriftMaxDecay;
      reasons.push(`-${T.conditionDriftMaxDecay} from volatility regime drift (${ratio.toFixed(2)}× entry)`);
    } else if (ratio > 1.25 || ratio < 0.75) {
      contributions.CONDITION_DRIFT = T.conditionDriftMaxDecay / 2;
      reasons.push(`-${(T.conditionDriftMaxDecay / 2).toFixed(0)} from mild volatility drift (${ratio.toFixed(2)}× entry)`);
    }
  }

  // Total decay is the MAX of contributions, not the sum — drivers overlap
  // semantically (e.g. agent reversal often coincides with condition drift)
  // and stacking would double-count. Picking the max keeps the worst signal
  // dominant without piling on.
  const decay = Math.min(
    Math.max(contributions.TIME, contributions.MAE_PRESSURE, contributions.AGENT_REVERSAL, contributions.CONDITION_DRIFT),
    100,
  );
  const primaryDriver = pickPrimary(contributions);
  let derivedCurrentConfidence = clamp(snap.entry.originalConfidence - decay, 0, 100);

  // If live confidence is supplied AND decay was meaningful, blend toward it.
  if (snap.live.currentConfidence !== null && decay > 0) {
    derivedCurrentConfidence = Math.min(derivedCurrentConfidence, snap.live.currentConfidence);
    reasons.push(`derived confidence floored by live re-evaluation: ${snap.live.currentConfidence}`);
  }

  if (decay === 0) reasons.push("no material decay drivers active");

  return {
    originalConfidence: snap.entry.originalConfidence,
    derivedCurrentConfidence,
    decay: Math.max(0, snap.entry.originalConfidence - derivedCurrentConfidence),
    primaryDriver,
    contributions,
    reasons,
  };
}

function pickPrimary(c: ConfidenceDecayReport["contributions"]): DecayDriver {
  let best: DecayDriver = "NO_DECAY";
  let bestVal = 0;
  (Object.keys(c) as Array<keyof typeof c>).forEach((k) => {
    if (c[k] > bestVal) { bestVal = c[k]; best = k; }
  });
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
