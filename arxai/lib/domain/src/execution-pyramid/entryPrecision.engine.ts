import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

// Rewards:
//   • Actual entry close to the ideal (in ATR units)
//   • Tight, sensible SL (~1× ATR)
//   • Healthy R:R (≥ 2)

export function scoreEntryPrecision(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const e = ctx.entry;

  if (e.atr <= 0) {
    blockers.push("ATR is zero — cannot evaluate entry precision");
    return result(0, warnings, blockers, "Zero ATR, cannot score");
  }
  if (e.actualEntry <= 0 || e.idealEntry <= 0) {
    blockers.push("Invalid entry prices");
    return result(0, warnings, blockers, "Invalid entry prices");
  }

  // 1. Distance from ideal (0..4)
  const distAtr = Math.abs(e.actualEntry - e.idealEntry) / e.atr;
  let distScore = 0;
  if (distAtr <= 0.1)      distScore = 4;
  else if (distAtr <= 0.25) distScore = 3;
  else if (distAtr <= 0.5)  distScore = 2;
  else if (distAtr <= 1.0)  distScore = 1;
  if (distAtr > 1.5) blockers.push(`Entry is ${distAtr.toFixed(2)}×ATR from ideal — chasing`);

  // 2. SL placement (0..3)
  let slScore = 0;
  const sl = e.stopDistanceAtrMultiple;
  if (sl >= 0.8 && sl <= 1.5)      slScore = 3;
  else if (sl >= 0.5 && sl < 0.8)  { slScore = 2; warnings.push(`SL is tight (${sl.toFixed(2)}×ATR)`); }
  else if (sl > 1.5 && sl <= 2.5)  { slScore = 2; warnings.push(`SL is wide (${sl.toFixed(2)}×ATR)`); }
  else if (sl > 2.5)               { slScore = 0; blockers.push(`SL >${sl.toFixed(2)}×ATR — risk too large per trade`); }
  else                             { slScore = 0; blockers.push(`SL <0.5×ATR — likely to be stopped on noise`); }

  // 3. R:R (0..3)
  let rrScore = 0;
  const rr = e.rewardRiskRatio;
  if (rr >= 3)        rrScore = 3;
  else if (rr >= 2)   rrScore = 2;
  else if (rr >= 1.5) { rrScore = 1; warnings.push(`R:R only ${rr.toFixed(2)}`); }
  else                { rrScore = 0; blockers.push(`R:R ${rr.toFixed(2)} <1.5 — unfavourable`); }

  const score = Math.max(0, Math.min(10, distScore + slScore + rrScore));

  return result(
    score, warnings, blockers,
    `Entry ${distAtr.toFixed(2)}×ATR from ideal (${distScore}/4), SL ${sl.toFixed(2)}×ATR (${slScore}/3), R:R ${rr.toFixed(2)} (${rrScore}/3) — ${score}/10`,
  );
}

function result(
  score: number, warnings: string[], blockers: string[], explanation: string,
): PyramidScoreReport {
  return {
    category: "entryPrecision",
    score, warnings, blockers, explanation,
    confidenceContribution: score * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}
