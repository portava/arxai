// ═══════════════════════════════════════════════════════════════════════════
// Monte Carlo Stress Test — pure. Replays the trade sequence many times,
// shuffling order and perturbing each trade's R-outcome with slippage,
// spread, and latency jitter. Reports robustness, ruin probability, and
// 5th/95th percentile final equity.
//
// PRNG: mulberry32 (seeded). Gaussian: Box–Muller.
// ═══════════════════════════════════════════════════════════════════════════

export interface MonteCarloInput {
  tradeRs: ReadonlyArray<number>;
  simulations?: number;            // default 500
  slippageJitterR?: number;        // 1σ jitter applied per trade
  spreadJitterR?: number;
  latencyDelayJitter01?: number;   // 0..1 — fraction of trade R nudged adversely
  ruinThresholdR?: number;         // default = -|sum(tradeRs)|/2 floor
  seed?: number;                   // default 0xC0FFEE
}

export interface MonteCarloResult {
  simulations: number;
  medianFinalR: number;
  meanFinalR: number;
  p05FinalR: number;
  p95FinalR: number;
  worstDrawdownR: number;
  ruinProbability01: number;
  robustness01: number;
  score01: number;
  reasons: string[];
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand: () => number): number {
  // Box–Muller — two uniforms → one standard normal
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!; out[i] = out[j]!; out[j] = tmp;
  }
  return out;
}

export function runMonteCarloValidation(i: MonteCarloInput): MonteCarloResult {
  const reasons: string[] = [];
  const sims = Math.max(1, Math.floor(i.simulations ?? 500));
  const slip = i.slippageJitterR ?? 0.05;
  const spread = i.spreadJitterR ?? 0.03;
  const lat = i.latencyDelayJitter01 ?? 0.02;
  const seed = i.seed ?? 0xC0FFEE;
  const rand = mulberry32(seed);

  if (i.tradeRs.length < 10) {
    reasons.push(`tradeRs.length=${i.tradeRs.length} below recommended minimum 10 — results unstable`);
  }
  const baselineSum = i.tradeRs.reduce((a, b) => a + b, 0);
  const ruinThr = i.ruinThresholdR ?? -Math.abs(baselineSum) / 2;

  const finals: number[] = [];
  let worstDD = 0;
  let ruined = 0;
  for (let s = 0; s < sims; s++) {
    const seq = shuffle(i.tradeRs.slice(), rand);
    let equity = 0; let peak = 0; let dd = 0;
    for (const baseR of seq) {
      // Adverse perturbation: slippage + spread sampled gaussian, latency
      // fraction subtracted (delays generally hurt fills).
      const r = baseR
              - Math.abs(gauss(rand)) * slip
              - Math.abs(gauss(rand)) * spread
              - Math.abs(baseR) * lat;
      equity += r;
      if (equity > peak) peak = equity;
      const drawdown = peak - equity;
      if (drawdown > dd) dd = drawdown;
    }
    if (dd > worstDD) worstDD = dd;
    if (equity <= ruinThr) ruined++;
    finals.push(equity);
  }
  finals.sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.max(0, Math.floor(q * finals.length)))]!;
  const median = finals[Math.floor(finals.length / 2)]!;
  const mean = finals.reduce((a, b) => a + b, 0) / finals.length;
  const ruin01 = ruined / sims;

  // Robustness: probability the run is profitable AND 5th-percentile is ≥ 0.
  const positive = finals.filter(x => x > 0).length / sims;
  const p05 = at(0.05);
  const robustness01 = Math.max(0, Math.min(1, positive - 0.5 * ruin01 + (p05 > 0 ? 0.2 : 0)));

  let score01 = robustness01;
  if (mean <= 0) score01 *= 0.5;
  if (worstDD > Math.abs(baselineSum) * 1.5) {
    score01 *= 0.7;
    reasons.push(`worstDrawdownR ${worstDD.toFixed(2)} exceeds 1.5× baseline cumulative gain`);
  }
  reasons.push(`sims=${sims}, ruin=${(ruin01 * 100).toFixed(1)}%, p05=${p05.toFixed(2)}R, median=${median.toFixed(2)}R`);

  return {
    simulations: sims,
    medianFinalR: median,
    meanFinalR: mean,
    p05FinalR: p05,
    p95FinalR: at(0.95),
    worstDrawdownR: worstDD,
    ruinProbability01: ruin01,
    robustness01,
    score01: Math.max(0, Math.min(1, score01)),
    reasons,
  };
}
