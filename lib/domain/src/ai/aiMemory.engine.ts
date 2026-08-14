import type { AiInsight } from "./aiInsight.types";

export interface MemoryQuery {
  symbol?: string;
  strategy?: string;
  session?: string;
  minSampleSize?: number;
}

export interface MemorySummary {
  totalInsights: number;
  averageStrength: number;
  bestRecommendation: AiInsight | null;
  worstRecommendation: AiInsight | null;
  byStrategy: Record<string, { count: number; avgStrength: number }>;
}

// Pure aggregation across a list of historical insights.
// Repository fetches them, this engine summarizes.
export function summarizeInsights(insights: AiInsight[], q: MemoryQuery = {}): MemorySummary {
  const filtered = insights.filter((i) => {
    if (q.symbol   && i.symbol   !== q.symbol)   return false;
    if (q.strategy && i.strategy !== q.strategy) return false;
    if (q.session  && i.session  !== q.session)  return false;
    if (q.minSampleSize != null && i.sampleSize < q.minSampleSize) return false;
    return true;
  });

  if (filtered.length === 0) {
    return { totalInsights: 0, averageStrength: 0, bestRecommendation: null, worstRecommendation: null, byStrategy: {} };
  }

  const sortedByStrength = [...filtered].sort((a, b) => b.strength - a.strength);
  const avgStrength = filtered.reduce((acc, i) => acc + i.strength, 0) / filtered.length;

  const byStrategy: MemorySummary["byStrategy"] = {};
  for (const i of filtered) {
    const key = i.strategy ?? "unknown";
    const bucket = byStrategy[key] ??= { count: 0, avgStrength: 0 };
    bucket.avgStrength = (bucket.avgStrength * bucket.count + i.strength) / (bucket.count + 1);
    bucket.count += 1;
  }

  return {
    totalInsights: filtered.length,
    averageStrength: avgStrength,
    bestRecommendation: sortedByStrength[0],
    worstRecommendation: sortedByStrength[sortedByStrength.length - 1],
    byStrategy,
  };
}
