// (M) Higher-timeframe bias card. Surfaces the dominant HTF condition
// separately so traders see "what the daily/H4 thinks" at a glance.

type Trend = "UP" | "DOWN" | "SIDEWAYS";

interface Props {
  higherTimeframe: string;
  higherTrend: { trend: Trend; strength: number };
  bestBias: "BUY" | "SELL" | "NEUTRAL";
}

const TREND_COPY: Record<Trend, { color: string; word: string }> = {
  UP:       { color: "text-green-400", word: "uptrend" },
  DOWN:     { color: "text-red-400",   word: "downtrend" },
  SIDEWAYS: { color: "text-slate-400", word: "ranging" },
};

export function HigherTimeframeBiasCard({ higherTimeframe, higherTrend, bestBias }: Props) {
  const tc = TREND_COPY[higherTrend.trend];
  const counterHtf =
    (higherTrend.trend === "UP" && bestBias === "SELL") ||
    (higherTrend.trend === "DOWN" && bestBias === "BUY");

  return (
    <div className="rounded-md border border-slate-700 bg-slate-950/40 p-3 text-xs">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Higher timeframe ({higherTimeframe})</div>
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-sm font-semibold ${tc.color}`}>
          {higherTimeframe} is in {tc.word} (strength {higherTrend.strength})
        </span>
        <span className="text-slate-300">Suggested bias: <span className="font-semibold text-slate-100">{bestBias}</span></span>
      </div>
      {counterHtf && (
        <p className="mt-2 text-orange-300">
          ⚠ Suggested bias is counter to the higher-timeframe trend. Counter-HTF entries carry elevated reversal risk — consider waiting or reducing size.
        </p>
      )}
    </div>
  );
}
