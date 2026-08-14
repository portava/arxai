export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE" | "BREAKOUT" | "CHOP" | "UNKNOWN";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  time: number; // epoch ms
}

export interface RegimeReport {
  regime: MarketRegime;
  confidence: number; // 0..100
  reasons: string[];
}

// Lightweight, deterministic classifier. Production callers can swap in a
// learned model; this serves as a baseline + sanity check.
//
// Heuristics:
//   trending  → close vs SMA20 + monotonic slope of last N closes
//   range     → low ATR + price oscillating around midline
//   breakout  → ATR expansion + close beyond N-bar high/low
//   chop      → low directional efficiency
export function classifyRegime(candles: Candle[]): RegimeReport {
  const reasons: string[] = [];
  if (candles.length < 30) {
    return { regime: "UNKNOWN", confidence: 0, reasons: ["Insufficient candles (<30)"] };
  }
  const closes = candles.map((c) => c.close);
  const window = closes.slice(-20);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const last = closes[closes.length - 1];
  const first = window[0];
  const slope = (last - first) / first;
  const directionalEfficiency = computeEfficiency(closes.slice(-20));
  const recentATR = computeATR(candles.slice(-15), 14);
  const olderATR = computeATR(candles.slice(-30, -15), 14);
  const atrRatio = olderATR > 0 ? recentATR / olderATR : 1;

  // Breakout: strong ATR expansion + close beyond recent extreme
  const recentHigh = Math.max(...candles.slice(-21, -1).map((c) => c.high));
  const recentLow  = Math.min(...candles.slice(-21, -1).map((c) => c.low));
  if (atrRatio > 1.5 && (last > recentHigh || last < recentLow)) {
    reasons.push(`ATR expansion ×${atrRatio.toFixed(2)} + range break`);
    return { regime: "BREAKOUT", confidence: Math.min(95, 60 + Math.round((atrRatio - 1.5) * 40)), reasons };
  }

  // Trending: clean slope + high directional efficiency
  if (Math.abs(slope) > 0.003 && directionalEfficiency > 0.55) {
    reasons.push(`Slope ${(slope * 100).toFixed(2)}% + efficiency ${directionalEfficiency.toFixed(2)}`);
    return {
      regime: slope > 0 ? "TRENDING_UP" : "TRENDING_DOWN",
      confidence: Math.min(95, 50 + Math.round(directionalEfficiency * 60)),
      reasons,
    };
  }

  // Range: low efficiency + price near mean
  if (directionalEfficiency < 0.35 && Math.abs(last - mean) / mean < 0.005) {
    reasons.push(`Low efficiency ${directionalEfficiency.toFixed(2)} + price near mean`);
    return { regime: "RANGE", confidence: 70, reasons };
  }

  reasons.push(`Mixed signals — efficiency ${directionalEfficiency.toFixed(2)}, slope ${(slope * 100).toFixed(2)}%`);
  return { regime: "CHOP", confidence: 55, reasons };
}

// Directional efficiency = |net move| / sum(|bar moves|), 0..1.
function computeEfficiency(closes: number[]): number {
  if (closes.length < 2) return 0;
  const net = Math.abs(closes[closes.length - 1] - closes[0]);
  let total = 0;
  for (let i = 1; i < closes.length; i++) total += Math.abs(closes[i] - closes[i - 1]);
  return total > 0 ? net / total : 0;
}

export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length === 0) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}
