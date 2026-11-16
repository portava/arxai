import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Meta-learning — analyze long-horizon performance trends and emit
// architectural recommendations. Distinct from agent-promotion which
// adjusts WEIGHTS within the existing architecture; meta-learning suggests
// changes TO the architecture (deprecate, retune, promote slot, etc).
// ═══════════════════════════════════════════════════════════════════════════

export const AgentMetaActionSchema = z.enum(["PROMOTE", "DEPRECATE", "RETUNE", "KEEP"]);
export type AgentMetaAction = z.infer<typeof AgentMetaActionSchema>;

export interface AgentPerformanceWindow {
  startIso: string;
  sampleCount: number;
  rightCount: number;
  expectancyR: number;
}

export interface AgentPerformanceTimeSeries {
  agentId: string;
  windows: AgentPerformanceWindow[];    // chronological, oldest first
}

export interface AgentMetaRecommendation {
  agentId: string;
  action: AgentMetaAction;
  confidence01: number;
  reasons: string[];
}

export const AGENT_META_THRESHOLDS = {
  minWindowsForTrend: 3,
  minSamplesPerWindow: 10,
  promoteImprovementR: 0.15,            // recent expectancy − early ≥ this
  deprecateRegressionR: -0.15,
  retuneOscillationStdR: 0.20,          // high std across windows = inconsistent
} as const;

export function analyzeAgentMeta(ts: AgentPerformanceTimeSeries): AgentMetaRecommendation {
  const T = AGENT_META_THRESHOLDS;
  const reasons: string[] = [];
  const valid = ts.windows.filter((w) => w.sampleCount >= T.minSamplesPerWindow);

  if (valid.length < T.minWindowsForTrend) {
    reasons.push(`only ${valid.length} valid windows (≥${T.minSamplesPerWindow} samples) < ${T.minWindowsForTrend} required`);
    return { agentId: ts.agentId, action: "KEEP", confidence01: 0.2, reasons };
  }

  const halfIdx = Math.floor(valid.length / 2);
  const earlyMean = mean(valid.slice(0, halfIdx).map((w) => w.expectancyR));
  const lateMean  = mean(valid.slice(halfIdx).map((w) => w.expectancyR));
  const delta = lateMean - earlyMean;
  const std = stdDev(valid.map((w) => w.expectancyR));
  reasons.push(`early mean ${earlyMean.toFixed(2)}R → late mean ${lateMean.toFixed(2)}R (Δ ${delta.toFixed(2)}R), std ${std.toFixed(2)}R`);

  if (std >= T.retuneOscillationStdR) {
    return { agentId: ts.agentId, action: "RETUNE", confidence01: Math.min(1, std / T.retuneOscillationStdR * 0.6),
      reasons: [...reasons, `std ${std.toFixed(2)}R ≥ ${T.retuneOscillationStdR}R — inconsistent, RETUNE`] };
  }
  if (delta >= T.promoteImprovementR) {
    return { agentId: ts.agentId, action: "PROMOTE", confidence01: Math.min(1, delta / T.promoteImprovementR * 0.5),
      reasons: [...reasons, `improvement ${delta.toFixed(2)}R ≥ ${T.promoteImprovementR}R — PROMOTE`] };
  }
  if (delta <= T.deprecateRegressionR) {
    return { agentId: ts.agentId, action: "DEPRECATE", confidence01: Math.min(1, Math.abs(delta) / Math.abs(T.deprecateRegressionR) * 0.5),
      reasons: [...reasons, `regression ${delta.toFixed(2)}R ≤ ${T.deprecateRegressionR}R — DEPRECATE`] };
  }
  return { agentId: ts.agentId, action: "KEEP", confidence01: 0.5, reasons: [...reasons, "stable trend — KEEP"] };
}

function mean(arr: number[]): number { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}
