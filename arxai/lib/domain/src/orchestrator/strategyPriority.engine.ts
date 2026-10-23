import type { OrchestrationMode } from "./orchestrator.engine";

export interface StrategyDescriptor {
  strategyId: string;
  enabled: boolean;
  expectancyR: number;
  sampleCount: number;
  preferredPhases?: string[];           // optional regime affinity
  currentPhaseMatch01?: number;         // 0..1 — caller decides match strength
}

export interface StrategySelectionResult {
  activeIds: string[];
  rankedScores: { strategyId: string; score: number }[];
  reasons: string[];
}

// selectActiveStrategies — rank strategies by composite score, then take
// only those above the mode-specific bar. PRESERVATION takes only the top
// scorer with positive expectancy; DEFENSE takes top 2; NORMAL/AGGRESSION
// take all enabled strategies above floor.
//
// Score = expectancyR (capped) × min(1, sqrt(samples/30)) × (0.5 + 0.5×phaseMatch)
// — sample-trust weighting matches the project pattern (sqrt growth to
// neutral until enough evidence).
export function selectActiveStrategies(
  strategies: StrategyDescriptor[],
  mode: OrchestrationMode,
  marketPhaseConfidence01: number,
): StrategySelectionResult {
  const reasons: string[] = [];
  const phaseConf = Math.max(0, Math.min(1, marketPhaseConfidence01));

  const scored = strategies
    .filter((s) => s.enabled)
    .map((s) => {
      const trust = Math.min(1, Math.sqrt(s.sampleCount / 30));
      const cappedEx = Math.max(-1, Math.min(1, s.expectancyR));
      const phaseMatch = s.currentPhaseMatch01 ?? 0.5;
      const phaseAdj = 0.5 + 0.5 * phaseMatch * phaseConf;
      const score = cappedEx * trust * phaseAdj;
      return { strategyId: s.strategyId, score, expectancyR: s.expectancyR };
    })
    .sort((a, b) => b.score - a.score);

  let cutoffCount: number;
  let minScore: number;
  switch (mode) {
    case "PRESERVATION": cutoffCount = 1;          minScore = 0.10; break;
    case "DEFENSE":      cutoffCount = 2;          minScore = 0.05; break;
    case "AGGRESSION":   cutoffCount = scored.length; minScore = -0.05; break;
    case "NORMAL":       cutoffCount = scored.length; minScore = 0.00; break;
  }

  const active = scored.slice(0, cutoffCount).filter((s) => s.score >= minScore);
  reasons.push(`mode=${mode} → keep top ${cutoffCount} above score ${minScore}; ${active.length}/${scored.length} active`);

  return {
    activeIds: active.map((s) => s.strategyId),
    rankedScores: scored.map(({ strategyId, score }) => ({ strategyId, score })),
    reasons,
  };
}
