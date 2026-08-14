// ═══════════════════════════════════════════════════════════════════════════
// Out-of-Sample Validator — pure. Compares in-sample vs out-of-sample
// expectancy. A strategy whose OOS expectancy collapses to < 50% of IS is
// flagged as overfitted. The score blends OOS / IS ratio with an
// overfitting-probability heuristic.
// ═══════════════════════════════════════════════════════════════════════════

export interface OutOfSampleInput {
  inSampleExpectancyR: number;
  outOfSampleExpectancyR: number;
  inSampleTrades: number;
  outOfSampleTrades: number;
  passRatio01?: number;               // OOS must be ≥ ratio × IS to pass; default 0.7
}
export interface OutOfSampleResult {
  ratio: number;
  oosPassing: boolean;
  overfittingProbability01: number;
  oosNet: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  score01: number;
  reasons: string[];
}

export function assessOutOfSample(i: OutOfSampleInput): OutOfSampleResult {
  const reasons: string[] = [];
  const passRatio = i.passRatio01 ?? 0.7;

  if (i.inSampleTrades < 30) reasons.push(`IS sample ${i.inSampleTrades} small — ratio interpretation weak`);
  if (i.outOfSampleTrades < 30) reasons.push(`OOS sample ${i.outOfSampleTrades} small — ratio interpretation weak`);

  const is = i.inSampleExpectancyR;
  const oos = i.outOfSampleExpectancyR;

  let ratio: number;
  if (is > 0) ratio = oos / is;
  else if (is === 0 && oos > 0) ratio = 1;
  else if (is === 0 && oos <= 0) ratio = 0;
  else /* is < 0 */ ratio = oos > 0 ? 1 : -Math.abs(oos / is);

  const oosNet = oos > 0.02 ? "POSITIVE" : (oos < -0.02 ? "NEGATIVE" : "NEUTRAL");
  const oosPassing = oos > 0 && ratio >= passRatio;

  // Overfitting probability — exaggerated IS performance with collapsed OOS
  // is the textbook signal. Heuristic clamps to [0,1].
  let overfit = 0;
  if (is > 0) {
    if (ratio < passRatio) overfit = Math.min(1, (passRatio - ratio) / passRatio);
    if (oosNet === "NEGATIVE") overfit = Math.max(overfit, 0.7);
  }
  if (i.inSampleTrades < 30 && is > 0.3) overfit = Math.max(overfit, 0.6);

  // Score: oosPassing → high; otherwise ratio scaled and overfit-penalised.
  let score01: number;
  if (oosPassing) score01 = Math.min(1, 0.6 + 0.4 * Math.min(1, ratio));
  else score01 = Math.max(0, Math.min(1, Math.max(0, ratio) * 0.6 - 0.3 * overfit));

  reasons.push(`OOS / IS ratio = ${ratio.toFixed(2)} (passRatio threshold = ${passRatio.toFixed(2)})`);
  reasons.push(`OOS expectancy = ${oos.toFixed(3)}R (${oosNet})`);
  reasons.push(`overfitting probability heuristic = ${overfit.toFixed(2)}`);
  if (!oosPassing) reasons.push(`OOS gate FAILED — strategy may be overfitted`);

  return {
    ratio, oosPassing,
    overfittingProbability01: overfit,
    oosNet, score01, reasons,
  };
}
