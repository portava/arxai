import {
  type CounterfactualSim, type HypotheticalSetup, type PriceWindow,
  DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// simulateCounterfactual — shared engine for Q1/Q2/Q5/Q6.
//
// Strategy (most-precise wins):
//   1. If bars[] provided AND SL or TP touched → walk bars in order;
//      first bar that breaches SL or TP determines the verdict.
//      Same-bar both-breach → BOTH_TOUCHED_AMBIGUOUS (conservative SL-first
//      pnl, since within-bar order is unknown).
//   2. Else if no bars but summary high/low touched both → BOTH_TOUCHED_AMBIGUOUS.
//   3. Else if only SL touched → SL_HIT_FIRST; only TP touched → TP_HIT_FIRST.
//   4. Else NEITHER_TOUCHED → use end-of-window pnl.
//
// Defenses:
//   • windowSeconds < minWindowSeconds  → WINDOW_TOO_SHORT (windowAdequate=false)
//   • riskPerUnitPrice ≤ 0              → WINDOW_TOO_SHORT (cannot compute R)
export function simulateCounterfactual(
  setup: HypotheticalSetup,
  window: PriceWindow,
): CounterfactualSim {
  const T = DECISION_QA_THRESHOLDS;
  const r = setup.riskPerUnitPrice;
  const dir = setup.direction;
  const entry = setup.entryPrice;

  if (window.windowSeconds < T.minWindowSeconds) {
    return zeroSim(`window ${window.windowSeconds}s < ${T.minWindowSeconds}s — too short`);
  }
  if (r <= 0) {
    return zeroSim("riskPerUnitPrice ≤ 0 — cannot compute R");
  }

  const mfePrice = dir === "BUY" ? Math.max(0, window.highSinceStart - entry) : Math.max(0, entry - window.lowSinceStart);
  const maePrice = dir === "BUY" ? Math.max(0, entry - window.lowSinceStart)  : Math.max(0, window.highSinceStart - entry);
  const mfeR = mfePrice / r;
  const maeR = maePrice / r;

  const slPrice = setup.stopLossPrice;
  const tpPrice = setup.takeProfitPrice;
  const slTouchedSummary = slPrice !== null && (dir === "BUY" ? window.lowSinceStart  <= slPrice : window.highSinceStart >= slPrice);
  const tpTouchedSummary = tpPrice !== null && (dir === "BUY" ? window.highSinceStart >= tpPrice : window.lowSinceStart  <= tpPrice);

  // ── 1. Bar-by-bar walk for ordered detection ──────────────────────────
  if (window.bars && window.bars.length > 0 && (slTouchedSummary || tpTouchedSummary)) {
    for (const bar of window.bars) {
      const slHere = slPrice !== null && (dir === "BUY" ? bar.low  <= slPrice : bar.high >= slPrice);
      const tpHere = tpPrice !== null && (dir === "BUY" ? bar.high >= tpPrice : bar.low  <= tpPrice);
      if (slHere && tpHere) {
        const pnl = -Math.abs(slPrice! - entry) / r;
        return ok("BOTH_TOUCHED_AMBIGUOUS", pnl, mfeR, maeR,
          [`bar @ ${bar.openTime}: both SL and TP within bar — assume SL first (conservative) → ${pnl.toFixed(2)}R`]);
      }
      if (slHere) {
        const pnl = -Math.abs(slPrice! - entry) / r;
        return ok("SL_HIT_FIRST", pnl, mfeR, maeR, [`bar @ ${bar.openTime}: SL hit → ${pnl.toFixed(2)}R`]);
      }
      if (tpHere) {
        const pnl = Math.abs(tpPrice! - entry) / r;
        return ok("TP_HIT_FIRST", pnl, mfeR, maeR, [`bar @ ${bar.openTime}: TP hit → +${pnl.toFixed(2)}R`]);
      }
    }
    // bars provided but no breach in any individual bar — fall through to summary
  }

  // ── 2/3. Summary-based ────────────────────────────────────────────────
  if (slTouchedSummary && tpTouchedSummary) {
    const pnl = -Math.abs(slPrice! - entry) / r;
    return ok("BOTH_TOUCHED_AMBIGUOUS", pnl, mfeR, maeR,
      [`both SL and TP touched in window, no bar ordering — assume SL first (conservative) → ${pnl.toFixed(2)}R`]);
  }
  if (slTouchedSummary) {
    const pnl = -Math.abs(slPrice! - entry) / r;
    return ok("SL_HIT_FIRST", pnl, mfeR, maeR, [`SL touched (no TP) → ${pnl.toFixed(2)}R`]);
  }
  if (tpTouchedSummary) {
    const pnl = Math.abs(tpPrice! - entry) / r;
    return ok("TP_HIT_FIRST", pnl, mfeR, maeR, [`TP touched (no SL) → +${pnl.toFixed(2)}R`]);
  }

  // ── 4. Neither — use end price ────────────────────────────────────────
  const endR = dir === "BUY" ? (window.endPrice - entry) / r : (entry - window.endPrice) / r;
  return ok("NEITHER_TOUCHED", endR, mfeR, maeR,
    [`neither SL nor TP touched; end-of-window pnl ${endR.toFixed(2)}R`]);
}

function zeroSim(reason: string): CounterfactualSim {
  return {
    simVerdict: "WINDOW_TOO_SHORT",
    simulatedPnlR: 0, mfeR: 0, maeR: 0,
    windowAdequate: false,
    reasons: [reason],
  };
}

function ok(
  simVerdict: CounterfactualSim["simVerdict"], pnl: number, mfeR: number, maeR: number, reasons: string[],
): CounterfactualSim {
  return { simVerdict, simulatedPnlR: pnl, mfeR, maeR, windowAdequate: true, reasons };
}
