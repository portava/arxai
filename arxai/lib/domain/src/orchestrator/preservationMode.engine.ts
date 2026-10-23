import type { OrchestrationDecision } from "./orchestrator.engine";

// applyPreservationMode — capital preservation. Tighter than DEFENSE.
// Quarter size, very high confidence bar, single concurrent trade max.
// NEVER upscales — only tightens. Composes with kill-switch which may
// further restrict.
export function applyPreservationMode(d: OrchestrationDecision): OrchestrationDecision {
  const reasons = [...d.reasons, "PRESERVATION mode applied — capital preservation prioritized"];
  const sizeMul = Math.min(d.globalSizeMultiplier, 0.25);
  const minConf = Math.max(d.minConfidenceThreshold, 85);
  const maxConc = Math.min(d.maxConcurrentTrades, 1);
  reasons.push(
    `globalSizeMultiplier ${d.globalSizeMultiplier.toFixed(2)} → ${sizeMul.toFixed(2)} (cap 0.25)`,
    `minConfidenceThreshold ${d.minConfidenceThreshold} → ${minConf} (raise to 85 — A+ only)`,
    `maxConcurrentTrades ${d.maxConcurrentTrades} → ${maxConc} (cap 1)`,
  );
  return { ...d, globalSizeMultiplier: sizeMul, minConfidenceThreshold: minConf, maxConcurrentTrades: maxConc, reasons };
}
