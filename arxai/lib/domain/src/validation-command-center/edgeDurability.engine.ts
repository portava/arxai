// ═══════════════════════════════════════════════════════════════════════════
// Edge Durability — pure. Detects whether the edge is decaying. Combines:
//   • recent vs baseline expectancy gap
//   • regime drift score
//   • trends in false-approval / false-block rates
//   • confidence calibration drift
//
// Decay levels: STABLE | MILD | DECAYING | SEVERE.
// ═══════════════════════════════════════════════════════════════════════════

export interface EdgeDurabilityInput {
  recentExpectancyR: number;
  baselineExpectancyR: number;
  regimeDriftScore01: number;             // 0=no drift, 1=heavy drift
  falseApprovalTrendDeltaPct01: number;   // positive = worsening
  falseBlockTrendDeltaPct01: number;
  calibrationDriftDeltaPct01: number;     // positive = drifting away from calibrated
}
export type EdgeDecayLevel = "STABLE" | "MILD" | "DECAYING" | "SEVERE";
export interface EdgeDurabilityResult {
  decayLevel: EdgeDecayLevel;
  decayPct01: number;
  expectancyGapPct01: number;
  score01: number;
  reasons: string[];
}

export function assessEdgeDurability(i: EdgeDurabilityInput): EdgeDurabilityResult {
  const reasons: string[] = [];
  const baseline = i.baselineExpectancyR;
  const expectancyGap = baseline > 0
    ? Math.max(0, Math.min(1, (baseline - i.recentExpectancyR) / baseline))
    : (i.recentExpectancyR <= 0 ? 1 : 0);

  // Composite decay = weighted average of all decay signals.
  const signals = [
    { name: "expectancyGap", v: expectancyGap, w: 0.35 },
    { name: "regimeDrift", v: Math.min(1, Math.max(0, i.regimeDriftScore01)), w: 0.20 },
    { name: "falseApprovalTrend", v: Math.min(1, Math.max(0, i.falseApprovalTrendDeltaPct01)), w: 0.15 },
    { name: "falseBlockTrend", v: Math.min(1, Math.max(0, i.falseBlockTrendDeltaPct01)), w: 0.10 },
    { name: "calibrationDrift", v: Math.min(1, Math.max(0, i.calibrationDriftDeltaPct01)), w: 0.20 },
  ];
  const decay = signals.reduce((s, x) => s + x.v * x.w, 0);

  let level: EdgeDecayLevel;
  if (decay >= 0.6) level = "SEVERE";
  else if (decay >= 0.4) level = "DECAYING";
  else if (decay >= 0.2) level = "MILD";
  else level = "STABLE";

  const score01 = Math.max(0, Math.min(1, 1 - decay));
  for (const s of signals) {
    if (s.v >= 0.3) reasons.push(`${s.name} elevated: ${s.v.toFixed(2)}`);
  }
  reasons.push(`composite decay = ${decay.toFixed(2)} → ${level}`);
  if (baseline <= 0) reasons.push("baseline expectancy ≤ 0 — durability is undefined; score conservative");

  return {
    decayLevel: level, decayPct01: decay,
    expectancyGapPct01: expectancyGap,
    score01, reasons,
  };
}
