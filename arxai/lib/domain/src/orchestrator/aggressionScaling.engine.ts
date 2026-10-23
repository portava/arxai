import type { OrchestrationDecision } from "./orchestrator.engine";

// applyAggressionScaling — modestly widen the envelope when proven
// favorable. Bounded so one good week cannot blow up a year of discipline.
//
// Caps: globalSizeMultiplier ≤ 1.50, minConfidenceThreshold ≥ 50,
// maxConcurrentTrades ≤ 5. Governor + trust-ladder still gate; this layer
// only nudges the orchestrator's own dials within bounded limits.
export function applyAggressionScaling(d: OrchestrationDecision): OrchestrationDecision {
  const reasons = [...d.reasons, "AGGRESSION mode applied — modest scaling within hard bounds"];
  const sizeMul = Math.min(1.5, d.globalSizeMultiplier * 1.25);
  const minConf = Math.max(50, d.minConfidenceThreshold - 5);
  const maxConc = Math.min(5, d.maxConcurrentTrades + 1);
  reasons.push(
    `globalSizeMultiplier ${d.globalSizeMultiplier.toFixed(2)} → ${sizeMul.toFixed(2)} (× 1.25, cap 1.5)`,
    `minConfidenceThreshold ${d.minConfidenceThreshold} → ${minConf} (−5, floor 50)`,
    `maxConcurrentTrades ${d.maxConcurrentTrades} → ${maxConc} (+1, cap 5)`,
  );
  return { ...d, globalSizeMultiplier: sizeMul, minConfidenceThreshold: minConf, maxConcurrentTrades: maxConc, reasons };
}
