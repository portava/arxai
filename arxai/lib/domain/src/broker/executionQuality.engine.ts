export interface ExecutionSample {
  requestedPrice: number;
  filledPrice: number;
  requestedAt: number;     // epoch ms
  filledAt: number;        // epoch ms
  pipSize?: number;        // for slippage in pips
}

export interface ExecutionQualityReport {
  sampleCount: number;
  avgSlippagePrice: number;
  avgSlippagePips: number | null;
  worstSlippagePrice: number;
  avgLatencyMs: number;
  worstLatencyMs: number;
  qualityScore: number;    // 0..100
  notes: string[];
}

// Higher score = better execution. Pure aggregation, no IO.
export function summarizeExecution(samples: ExecutionSample[]): ExecutionQualityReport {
  const notes: string[] = [];
  if (samples.length === 0) {
    return {
      sampleCount: 0, avgSlippagePrice: 0, avgSlippagePips: null,
      worstSlippagePrice: 0, avgLatencyMs: 0, worstLatencyMs: 0,
      qualityScore: 0, notes: ["No execution samples"],
    };
  }
  const slippages = samples.map((s) => Math.abs(s.filledPrice - s.requestedPrice));
  const latencies = samples.map((s) => Math.max(0, s.filledAt - s.requestedAt));
  const avgSlip = slippages.reduce((a, b) => a + b, 0) / slippages.length;
  const worstSlip = Math.max(...slippages);
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const worstLat = Math.max(...latencies);

  const pipSize = samples[0].pipSize;
  const avgSlipPips = pipSize && pipSize > 0 ? avgSlip / pipSize : null;

  // Quality score: 100 = no slip + 0ms latency. Decays linearly.
  const slipPenalty = avgSlipPips != null ? Math.min(50, avgSlipPips * 5) : Math.min(50, avgSlip * 1000);
  const latPenalty  = Math.min(50, avgLat / 20);
  const qualityScore = Math.max(0, Math.round(100 - slipPenalty - latPenalty));

  if (avgLat > 500) notes.push(`High average latency ${Math.round(avgLat)}ms`);
  if (worstLat > 2000) notes.push(`Worst-case latency ${Math.round(worstLat)}ms`);
  if (avgSlipPips != null && avgSlipPips > 1) notes.push(`Average slippage ${avgSlipPips.toFixed(2)} pips`);

  return {
    sampleCount: samples.length,
    avgSlippagePrice: avgSlip,
    avgSlippagePips: avgSlipPips,
    worstSlippagePrice: worstSlip,
    avgLatencyMs: avgLat,
    worstLatencyMs: worstLat,
    qualityScore,
    notes,
  };
}
