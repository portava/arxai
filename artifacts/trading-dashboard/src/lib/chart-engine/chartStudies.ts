import type { ChartEngineCandle } from "./types";

export type StudyKind = "sma" | "ema" | "bollinger" | "rsi" | "macd";
export interface ChartStudy { kind: StudyKind; period: number; color: string; multiplier?: number; slow?: number; signal?: number }
export interface StudyPoint { time: number; values: (number | null)[] }
interface State { sum: number; ema: number | null; gain: number; loss: number; slow: number | null; signal: number | null; signalSum: number; signalCount: number }
export const STUDY_DEFAULTS: ChartStudy[] = [
  { kind: "sma", period: 20, color: "#fbbf24" },
  { kind: "ema", period: 50, color: "#38bdf8" },
  { kind: "bollinger", period: 20, multiplier: 2, color: "#a78bfa" },
  { kind: "rsi", period: 14, color: "#e879f9" },
  { kind: "macd", period: 12, slow: 26, signal: 9, color: "#2dd4bf" },
];
const ema = (value: number, previous: number | null, period: number, seed: number) => previous == null ? seed / period : previous + (2 / (period + 1)) * (value - previous);

/** Close-price studies. Seed EMA with SMA; RSI uses Wilder smoothing and a
 * neutral 50 for a completely flat window. No values before the warm-up ends.
 * Checkpoints let forming-bar revisions replace ONE state without compounding
 * the same tick repeatedly. Historical corrections rebuild from the caller's
 * first changed index. No future bar is consulted. */
export class StudyCalculator {
  private states: State[] = [];
  readonly points: StudyPoint[] = [];
  constructor(readonly config: ChartStudy) {}
  calculate(bars: ChartEngineCandle[], from = 0): StudyPoint[] {
    const c = this.config, p = c.period;
    from = Math.max(0, Math.min(from, this.states.length, bars.length));
    this.states.length = from; this.points.length = from;
    const changed: StudyPoint[] = [];
    for (let i = from; i < bars.length; i++) {
      const close = bars[i]!.close, prev = this.states[i - 1];
      const s: State = { sum: (prev?.sum ?? 0) + close - (i >= p ? bars[i - p]!.close : 0), ema: prev?.ema ?? null, gain: prev?.gain ?? 0, loss: prev?.loss ?? 0, slow: prev?.slow ?? null, signal: prev?.signal ?? null, signalSum: prev?.signalSum ?? 0, signalCount: prev?.signalCount ?? 0 };
      let values: (number | null)[] = [null];
      if (c.kind === "sma") values = [i >= p - 1 ? s.sum / p : null];
      if (c.kind === "ema" || c.kind === "macd") {
        if (i >= p - 1) s.ema = ema(close, prev?.ema ?? null, p, s.sum);
        values = [s.ema];
      }
      if (c.kind === "bollinger") {
        values = [null, null, null];
        if (i >= p - 1) {
          const mean = s.sum / p;
          // Centered population variance avoids cancellation on small FX moves.
          let variance = 0;
          for (let j = i - p + 1; j <= i; j++) variance += (bars[j]!.close - mean) ** 2;
          const width = Math.sqrt(variance / p) * (c.multiplier ?? 2);
          values = [mean, mean + width, mean - width];
        }
      }
      if (c.kind === "rsi") {
        const delta = i ? close - bars[i - 1]!.close : 0;
        if (i <= p) { s.gain += Math.max(0, delta); s.loss += Math.max(0, -delta); }
        if (i === p) { s.gain /= p; s.loss /= p; }
        if (i > p) { s.gain = (s.gain * (p - 1) + Math.max(0, delta)) / p; s.loss = (s.loss * (p - 1) + Math.max(0, -delta)) / p; }
        values = [i < p ? null : s.gain === 0 && s.loss === 0 ? 50 : s.loss === 0 ? 100 : 100 - 100 / (1 + s.gain / s.loss)];
      }
      if (c.kind === "macd") {
        const slow = c.slow ?? 26, signal = c.signal ?? 9;
        if (i === slow - 1) s.slow = bars.slice(0, slow).reduce((sum, b) => sum + b.close, 0) / slow;
        if (i >= slow) s.slow = ema(close, prev?.slow ?? null, slow, 0);
        const macd = s.slow != null && s.ema != null ? s.ema - s.slow : null;
        if (macd != null) {
          s.signalCount++; s.signalSum += macd;
          if (s.signalCount >= signal) s.signal = ema(macd, prev?.signal ?? null, signal, s.signalSum);
        }
        values = [macd, s.signal, macd != null && s.signal != null ? macd - s.signal : null];
      }
      this.states.push(s);
      const point = { time: bars[i]!.time, values };
      this.points.push(point); changed.push(point);
    }
    return changed;
  }
}
