import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Mass Disagreement Scenario — what happens when agents/strategies issue
// strongly conflicting signals at the same time. High disagreement variance
// + high collective conviction = decision paralysis or whipsaw losses.
// ═══════════════════════════════════════════════════════════════════════════

export const AgentSignalSchema = z.object({
  agentId: z.string().min(1),
  // Signal in [-1, +1]: -1 = strong sell, +1 = strong buy.
  signal: z.number().min(-1).max(1),
  conviction01: z.number().min(0).max(1),
});
export type AgentSignal = z.infer<typeof AgentSignalSchema>;

export const MassDisagreementInputsSchema = z.object({
  signals: z.array(AgentSignalSchema).min(2),
  paralysisDisagreementThreshold: z.number().min(0).max(1).default(0.6),
});
export type MassDisagreementInputs = z.infer<typeof MassDisagreementInputsSchema>;

export interface MassDisagreementScenario {
  meanSignal: number;
  signalVariance01: number;
  meanConviction01: number;
  paralysis: boolean;
  reasons: string[];
}

export function simulateMassDisagreement(
  i: MassDisagreementInputs,
): MassDisagreementScenario {
  const n = i.signals.length;
  const meanSignal = i.signals.reduce((s, x) => s + x.signal, 0) / n;
  const variance =
    i.signals.reduce((s, x) => s + (x.signal - meanSignal) ** 2, 0) / n;
  // Variance of [-1,1] uniform is 4/12 = 0.333; normalise to ~[0,1].
  const signalVariance01 = Math.min(1, variance / 0.333);
  const meanConviction01 = i.signals.reduce((s, x) => s + x.conviction01, 0) / n;
  const paralysis =
    signalVariance01 >= i.paralysisDisagreementThreshold && meanConviction01 >= 0.6;
  return {
    meanSignal,
    signalVariance01,
    meanConviction01,
    paralysis,
    reasons: [
      `${n} agents — meanSignal=${meanSignal.toFixed(3)}, variance01=${signalVariance01.toFixed(3)}, meanConviction=${meanConviction01.toFixed(3)}`,
      paralysis ? "PARALYSIS — recommend NO-TRADE freeze" : "no paralysis",
    ],
  };
}
