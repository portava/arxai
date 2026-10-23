// disagreementScore — single 0..1 number summarizing how divided the
// council is. 0 = unanimous; 1 = maximally split.
//
// Composition (weighted):
//   60% directional split  — buy-vs-sell weight imbalance (0 if one-sided)
//   30% quality dispersion — max-min quality gap normalized to 0..1
//   10% block-vs-pass       — fixed 0.5 penalty when both occur

import type {
  AgentVerdict, DirectionVerdict, HardBlockVerdict, QualityVerdict,
} from "../agentSystem.types";

export interface DisagreementBreakdown {
  score01: number;
  directional01: number;
  quality01: number;
  block01: number;
  reasons: string[];
}

export function disagreementScore(verdicts: AgentVerdict[]): DisagreementBreakdown {
  const reasons: string[] = [];

  // Directional split.
  const dir = verdicts.filter((v): v is DirectionVerdict =>
    v.category === "DIRECTION" && v.direction !== "ABSTAIN");
  let directional01 = 0;
  if (dir.length >= 2) {
    const buy  = dir.filter(v => v.direction === "BUY").reduce((s, v) => s + v.conviction, 0);
    const sell = dir.filter(v => v.direction === "SELL").reduce((s, v) => s + v.conviction, 0);
    const total = buy + sell;
    if (total > 0) {
      // 1.0 when buy==sell; 0.0 when one side is everything.
      directional01 = (2 * Math.min(buy, sell)) / total;
    }
    reasons.push(`directional: ${buy.toFixed(0)} BUY-conv vs ${sell.toFixed(0)} SELL-conv`);
  } else {
    reasons.push("directional: too few active direction agents");
  }

  // Quality dispersion.
  const q = verdicts.filter((v): v is QualityVerdict => v.category === "QUALITY");
  let quality01 = 0;
  if (q.length >= 2) {
    const scores = q.map(x => x.qualityScore);
    const min = Math.min(...scores), max = Math.max(...scores);
    quality01 = Math.min(1, (max - min) / 100);
    reasons.push(`quality dispersion: ${(max - min).toFixed(0)} pts (min ${min.toFixed(0)}, max ${max.toFixed(0)})`);
  }

  // Block vs pass at hard-block level.
  const blocks = verdicts.filter((v): v is HardBlockVerdict => v.category === "HARD_BLOCK");
  const vetoed = blocks.filter(b => b.vetoed).length;
  const passed = blocks.length - vetoed;
  let block01 = 0;
  if (vetoed > 0 && passed > 0) {
    block01 = 0.5;
    reasons.push(`hard-block split: ${vetoed} veto vs ${passed} pass`);
  }

  const score01 = Math.max(0, Math.min(1,
    0.60 * directional01 + 0.30 * quality01 + 0.10 * block01));

  return { score01, directional01, quality01, block01, reasons };
}
