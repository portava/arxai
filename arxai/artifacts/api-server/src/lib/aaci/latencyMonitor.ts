// AACI Latency Monitor — in-process ring buffer of system latency samples.
//
// Feeds the Speed/Latency (S) sub-score of the AACI master formula. ADVISORY
// ONLY — never on a hot path, never an execution gate. Best-effort: recording a
// sample never throws into a caller. The buffer is bounded so it cannot grow
// unbounded; only the most recent sample per benchmark is used for scoring.

import {
  AACI_SPEED_BENCHMARK_BUDGETS_MS,
  type AaciLatencyRecord,
} from "@workspace/domain/aaci";

const MAX_SAMPLES = 256;

// Ring buffer of recent samples (most recent last).
const buffer: AaciLatencyRecord[] = [];

/**
 * Record a latency sample for a named benchmark. Unknown benchmarks are still
 * stored (with a default budget) but only weighted benchmarks affect the score.
 */
export function recordAaciLatency(benchmark: string, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const budgetMs = AACI_SPEED_BENCHMARK_BUDGETS_MS[benchmark] ?? 1_000;
  buffer.push({
    benchmark,
    latencyMs,
    budgetMs,
    recordedAt: new Date().toISOString(),
  });
  if (buffer.length > MAX_SAMPLES) buffer.splice(0, buffer.length - MAX_SAMPLES);
}

/**
 * Return the most recent sample per benchmark (the values the Speed sub-score
 * reads). Returns an empty array when nothing has been recorded — the scorer
 * fail-opens to a neutral score rather than fabricating a fast/slow reading.
 */
export function getLatestAaciLatencyRecords(): AaciLatencyRecord[] {
  const latest = new Map<string, AaciLatencyRecord>();
  for (const rec of buffer) latest.set(rec.benchmark, rec);
  return [...latest.values()];
}

/** Measure an async operation and record its latency under a benchmark name. */
export async function measureAaciLatency<T>(
  benchmark: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    recordAaciLatency(benchmark, Date.now() - start);
  }
}
