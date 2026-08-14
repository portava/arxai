import type { OrchestrationDecision } from "./orchestrator.engine";

// applyDefenseMode — tighten the envelope when conditions are unfavorable
// but not yet dangerous. Half size, raise confidence bar, fewer concurrent
// trades. NEVER upscales — only tightens.
export function applyDefenseMode(d: OrchestrationDecision): OrchestrationDecision {
  const reasons = [...d.reasons, "DEFENSE mode applied"];
  const sizeMul = Math.min(d.globalSizeMultiplier, 0.5);
  const minConf = Math.max(d.minConfidenceThreshold, 75);
  const maxConc = Math.min(d.maxConcurrentTrades, 2);
  reasons.push(
    `globalSizeMultiplier ${d.globalSizeMultiplier.toFixed(2)} → ${sizeMul.toFixed(2)} (cap 0.5)`,
    `minConfidenceThreshold ${d.minConfidenceThreshold} → ${minConf} (raise to 75)`,
    `maxConcurrentTrades ${d.maxConcurrentTrades} → ${maxConc} (cap 2)`,
  );
  return { ...d, globalSizeMultiplier: sizeMul, minConfidenceThreshold: minConf, maxConcurrentTrades: maxConc, reasons };
}
