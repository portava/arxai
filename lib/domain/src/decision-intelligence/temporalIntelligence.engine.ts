import {
  type DecisionRecord, type TemporalProfile, type TemporalEdge,
  type TradingSession, type MarketRegime, clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Temporal Intelligence — bucket decisions by (session × regime × hourOfDay)
// and compute per-bucket expectancy + edgeQuality. Identifies best/worst
// buckets and whether the current bucket should be avoided.
//
//   bucketLabel := `${session}·${regime}·H${hour}`
//   edgeQuality01 = sampleSizeWeight × ((tanh(E[R]) + 1)/2)
//   sampleSizeWeight = n / (n + K)   where K = 10 (smoothing constant)
//
//   avoidNow := currentBucket && (E[R] < 0 AND n ≥ minN AND edgeQuality < 0.4)
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface TemporalInput {
  records: ReadonlyArray<DecisionRecord>;
  current?: { session: TradingSession; regime: MarketRegime; hourOfDay: number };
  minSampleForAvoid?: number;       // default 10
  topK?: number;                     // default 5
}

export function computeTemporalProfile(input: TemporalInput): TemporalProfile {
  const reasons: string[] = [];
  const minN = input.minSampleForAvoid ?? 10;
  const topK = input.topK ?? 5;

  // Aggregate.
  const buckets = new Map<string, { sum: number; n: number; session: TradingSession; regime: MarketRegime; hour: number }>();
  for (const r of input.records) {
    if (!(r.kind === "ENTRY" || r.kind === "SCALE_IN" || r.kind === "SCALE_OUT" || r.kind === "EXIT")) continue;
    if (typeof r.realizedR !== "number") continue;
    if (r.outcome === "PENDING") continue;
    const hour = parseHour(r.takenAtIso);
    const key = `${r.session}·${r.regime}·H${hour.toString().padStart(2, "0")}`;
    const b = buckets.get(key) ?? { sum: 0, n: 0, session: r.session, regime: r.regime, hour };
    b.sum += r.realizedR; b.n += 1;
    buckets.set(key, b);
  }

  const edges: TemporalEdge[] = [];
  for (const [label, b] of buckets) {
    const expectancyR = b.sum / b.n;
    const sampleWeight = b.n / (b.n + 10);
    const edgeQuality01 = clamp01(sampleWeight * ((Math.tanh(expectancyR) + 1) / 2));
    edges.push({ bucketLabel: label, expectancyR, sampleSize: b.n, edgeQuality01 });
  }

  const sortedDesc = [...edges].sort((a, b) => b.edgeQuality01 - a.edgeQuality01);
  const sortedAsc  = [...edges].sort((a, b) => a.edgeQuality01 - b.edgeQuality01);
  const bestBuckets = sortedDesc.slice(0, topK);
  const worstBuckets = sortedAsc.slice(0, topK);

  let currentBucket: TemporalEdge | null = null;
  let avoidNow = false;
  if (input.current) {
    const key = `${input.current.session}·${input.current.regime}·H${input.current.hourOfDay.toString().padStart(2, "0")}`;
    currentBucket = edges.find((e) => e.bucketLabel === key) ?? null;
    if (currentBucket
        && currentBucket.expectancyR < 0
        && currentBucket.sampleSize >= minN
        && currentBucket.edgeQuality01 < 0.4) {
      avoidNow = true;
      reasons.push(`avoidNow=true: ${key} E[R] ${currentBucket.expectancyR.toFixed(3)} (n=${currentBucket.sampleSize}, q ${currentBucket.edgeQuality01.toFixed(2)})`);
    } else if (currentBucket) {
      reasons.push(`current bucket ${key} E[R] ${currentBucket.expectancyR.toFixed(3)} q ${currentBucket.edgeQuality01.toFixed(2)} — proceed`);
    } else {
      reasons.push(`current bucket ${key} has no history — neutral`);
    }
  }
  reasons.push(`buckets analysed ${edges.length}`);

  return { bestBuckets, worstBuckets, currentBucket, avoidNow, reasons };
}

function parseHour(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return d.getUTCHours();
}
