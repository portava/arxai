import {
  DEFAULT_STALENESS_SECONDS,
  type Mt5LatencyReading, type Mt5LatencySensorPort, type SensorReading,
} from "./liveInputs.types";

const HARD_BLOCK_P95_MS = 800;
const WARN_P95_MS       = 400;

export interface ReadMt5LatencySensorInput {
  port: Mt5LatencySensorPort;
  windowSeconds?: number;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readMt5LatencySensor(input: ReadMt5LatencySensorInput): Promise<SensorReading<Mt5LatencyReading>> {
  const now = input.now ?? new Date();
  const win = input.windowSeconds ?? 60;
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.mt5Latency;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const [samples, lastObservedAt] = await Promise.all([
    input.port.getRecentSamples(win).catch(() => []),
    input.port.getLastObservedAt().catch(() => null),
  ]);

  let ageSeconds: number | null = null;
  if (lastObservedAt) ageSeconds = Math.max(0, (now.getTime() - new Date(lastObservedAt).getTime()) / 1000);

  if (samples.length === 0) {
    return {
      sensor: "mt5Latency", value: null,
      health: { isHealthy: false, isStale: true, ageSeconds, reasons: ["no latency samples"] },
      warnings, blockers: ["No MT5 latency samples — bridge may be down"],
      capturedAt: now.toISOString(),
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50Ms = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  const avgMs = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const lastRoundtripMs = samples[samples.length - 1];

  const isStale = (ageSeconds ?? Number.POSITIVE_INFINITY) > stale;
  if (isStale) blockers.push(`Latency feed stale (${ageSeconds?.toFixed(1)}s > ${stale}s)`);

  if (p95Ms > HARD_BLOCK_P95_MS) {
    blockers.push(`MT5 p95 latency ${p95Ms.toFixed(0)}ms > ${HARD_BLOCK_P95_MS}ms`);
  } else if (p95Ms > WARN_P95_MS) {
    warnings.push(`MT5 p95 latency elevated: ${p95Ms.toFixed(0)}ms`);
  }

  const value: Mt5LatencyReading = {
    samples: samples.length, p50Ms, p95Ms, avgMs,
    lastRoundtripMs, lastObservedAt,
  };

  return {
    sensor: "mt5Latency", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? ["healthy"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}
