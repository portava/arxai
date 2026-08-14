// Volatility Relationship Matrix — PURE & deterministic. Computes per-symbol
// direction/momentum and pairwise correlation / lead-lag / decoupling from REAL
// candle series only. Deriv synthetic indices are independent feeds, so any
// relationship reported here is MEASURED from the supplied candles — never
// assumed. Insufficient data ⇒ honest blind node, never a fabricated number.

import type { SignalCandle } from "../signal-intelligence/signalIntelligence.types.js";
import { clamp, mean, round } from "../signal-intelligence/_math.js";

const MIN_CANDLES = 20;
const RECENT_WINDOW = 10;

export type MatrixDirection = "UP" | "DOWN" | "FLAT";
export type MatrixMomentum = "EXPANDING" | "STEADY" | "COMPRESSING" | "UNKNOWN";

export interface VolatilityNode {
  symbol: string;
  displayName: string;
  hasSufficientData: boolean;
  direction: MatrixDirection;
  momentum: MatrixMomentum;
  changePct: number | null;
  volatilityPct: number | null;
  sampleSize: number;
}

export interface VolatilityPair {
  symbolA: string;
  symbolB: string;
  correlation: number | null;
  recentCorrelation: number | null;
  /** Which symbol's move tends to lead, by best lagged correlation. */
  leader: string | null;
  lagBars: number;
  /** Normally-together pair now diverging (opposite run). */
  decoupled: boolean;
  sampleSize: number;
  note: string;
}

export interface VolatilityMatrix {
  generatedAt: string;
  nodes: VolatilityNode[];
  pairs: VolatilityPair[];
  /** Pairs that just decoupled — surfaced as opposite-run alerts upstream. */
  decoupledPairs: VolatilityPair[];
  hasData: boolean;
}

export interface VolatilitySeriesInput {
  symbol: string;
  displayName: string;
  candles: SignalCandle[] | null;
}

function closesOf(candles: SignalCandle[]): number[] {
  return candles.map((c) => c.close).filter((n) => Number.isFinite(n));
}

function returnsOf(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev === 0) { out.push(0); continue; }
    out.push((closes[i]! - prev) / prev);
  }
  return out;
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ax = a.slice(a.length - n);
  const bx = b.slice(b.length - n);
  const ma = mean(ax);
  const mb = mean(bx);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i]! - ma;
    const y = bx[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return round(clamp(num / Math.sqrt(da * db), -1, 1), 3);
}

function buildNode(input: VolatilitySeriesInput): VolatilityNode {
  const candles = input.candles ?? [];
  const closes = closesOf(candles);
  if (closes.length < MIN_CANDLES) {
    return {
      symbol: input.symbol,
      displayName: input.displayName,
      hasSufficientData: false,
      direction: "FLAT",
      momentum: "UNKNOWN",
      changePct: null,
      volatilityPct: null,
      sampleSize: closes.length,
    };
  }
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const changePct = first !== 0 ? round(((last - first) / first) * 100, 3) : null;
  const rets = returnsOf(closes);
  const volatilityPct = round(Math.sqrt(mean(rets.map((r) => r * r))) * 100, 3);
  const recent = rets.slice(-RECENT_WINDOW);
  const earlier = rets.slice(0, Math.max(1, rets.length - RECENT_WINDOW));
  const recentVol = Math.sqrt(mean(recent.map((r) => r * r)));
  const earlierVol = Math.sqrt(mean(earlier.map((r) => r * r)));
  let momentum: MatrixMomentum = "STEADY";
  if (earlierVol > 0) {
    const ratio = recentVol / earlierVol;
    momentum = ratio > 1.25 ? "EXPANDING" : ratio < 0.8 ? "COMPRESSING" : "STEADY";
  }
  const direction: MatrixDirection =
    changePct == null ? "FLAT" : changePct > 0.02 ? "UP" : changePct < -0.02 ? "DOWN" : "FLAT";
  return {
    symbol: input.symbol,
    displayName: input.displayName,
    hasSufficientData: true,
    direction,
    momentum,
    changePct,
    volatilityPct,
    sampleSize: closes.length,
  };
}

function laggedCorrelation(a: number[], b: number[]): { corr: number | null; lag: number; leader: string | null } {
  // lag 0, +1 (a leads b), -1 (b leads a)
  const c0 = pearson(a, b);
  const cAleads = pearson(a.slice(0, -1), b.slice(1)); // a_{t} vs b_{t+1}
  const cBleads = pearson(a.slice(1), b.slice(0, -1)); // a_{t+1} vs b_{t}
  const candidates: { corr: number | null; lag: number; who: "none" | "a" | "b" }[] = [
    { corr: c0, lag: 0, who: "none" },
    { corr: cAleads, lag: 1, who: "a" },
    { corr: cBleads, lag: 1, who: "b" },
  ];
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.corr != null && (best.corr == null || Math.abs(c.corr) > Math.abs(best.corr))) best = c;
  }
  return { corr: best.corr, lag: best.lag, leader: best.who === "none" ? null : best.who };
}

export function buildVolatilityMatrix(
  inputs: VolatilitySeriesInput[],
  now: number,
): VolatilityMatrix {
  const generatedAt = new Date(now).toISOString();
  const nodes = inputs.map(buildNode);
  const usable = inputs.filter((i) => (i.candles ?? []).length >= MIN_CANDLES);
  const retsBySymbol = new Map<string, number[]>();
  for (const i of usable) retsBySymbol.set(i.symbol, returnsOf(closesOf(i.candles ?? [])));

  const pairs: VolatilityPair[] = [];
  const decoupled: VolatilityPair[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!;
      const b = usable[j]!;
      const ra = retsBySymbol.get(a.symbol)!;
      const rb = retsBySymbol.get(b.symbol)!;
      const n = Math.min(ra.length, rb.length);
      const corr = pearson(ra, rb);
      const recentCorr = pearson(ra.slice(-RECENT_WINDOW), rb.slice(-RECENT_WINDOW));
      const lag = laggedCorrelation(ra, rb);
      const leader =
        lag.leader === "a" ? a.symbol : lag.leader === "b" ? b.symbol : null;
      // Decoupled = normally move together (corr ≥ 0.5) but recently diverging.
      const isDecoupled = corr != null && corr >= 0.5 && recentCorr != null && recentCorr <= -0.2;
      const pair: VolatilityPair = {
        symbolA: a.symbol,
        symbolB: b.symbol,
        correlation: corr,
        recentCorrelation: recentCorr,
        leader,
        lagBars: lag.lag,
        decoupled: isDecoupled,
        sampleSize: n,
        note: corr == null
          ? "Insufficient overlap to measure."
          : isDecoupled
            ? `Normally correlated (r=${corr}) but now diverging (recent r=${recentCorr}).`
            : `r=${corr}${leader ? `, ${leader} leads` : ""}.`,
      };
      pairs.push(pair);
      if (isDecoupled) decoupled.push(pair);
    }
  }

  return {
    generatedAt,
    nodes,
    pairs,
    decoupledPairs: decoupled,
    hasData: usable.length >= 2,
  };
}
