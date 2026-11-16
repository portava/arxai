// ═══════════════════════════════════════════════════════════════════════════
// Evidence Decay — pure. Older validation evidence loses strength via
// exponential decay (half-life model). The default half-life is 168 hours
// (7 days), meaning evidence one half-life old contributes 50% of its
// original weight to the decayed total.
//
// Output:
//   • items: every input item with its decayed weight
//   • totalRawWeight, totalDecayedWeight
//   • decayedRatio01 = decayed / raw  (0..1)
//   • effectiveAgeHours — ln(2)/decayLambda equivalent
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from "./confidenceHealth.engine";

export interface EvidenceItem {
  kind: string;
  ageHours: number;
  weight: number;
  meta?: Record<string, unknown>;
}
export interface EvidenceDecayInput {
  candidateId: string;
  items: ReadonlyArray<EvidenceItem>;
  halfLifeHours?: number;           // default 168h (7 days)
}
export interface DecayedItem extends EvidenceItem { decayedWeight: number; decayFactor01: number }
export interface EvidenceDecayResult {
  candidateId: string;
  items: DecayedItem[];
  totalRawWeight: number;
  totalDecayedWeight: number;
  decayedRatio01: number;
  halfLifeHours: number;
  reasons: string[];
}

export function decayEvidence(i: EvidenceDecayInput): EvidenceDecayResult {
  const reasons: string[] = [];
  const halfLife = Math.max(0.001, i.halfLifeHours ?? 168);
  const items: DecayedItem[] = i.items.map(it => {
    const age = Math.max(0, it.ageHours);
    const factor = Math.pow(0.5, age / halfLife);
    return {
      ...it,
      decayedWeight: it.weight * factor,
      decayFactor01: clamp01(factor),
    };
  });
  const raw     = items.reduce((s, x) => s + x.weight, 0);
  const decayed = items.reduce((s, x) => s + x.decayedWeight, 0);
  const ratio   = raw > 0 ? clamp01(decayed / raw) : 0;
  reasons.push(`half-life ${halfLife}h | decayed ${decayed.toFixed(3)}/${raw.toFixed(3)} (${(ratio * 100).toFixed(1)}%)`);
  return {
    candidateId: i.candidateId,
    items,
    totalRawWeight: raw,
    totalDecayedWeight: decayed,
    decayedRatio01: ratio,
    halfLifeHours: halfLife,
    reasons,
  };
}
