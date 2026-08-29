// (M) Higher-timeframe bias card. Surfaces the dominant HTF condition
// separately so traders see "what the daily/H4 thinks" at a glance.

type Trend = "UP" | "DOWN" | "SIDEWAYS";

interface Props {
  higherTimeframe: string;
  higherTrend: { trend: Trend; strength: number };
  bestBias: "BUY" | "SELL" | "NEUTRAL";
}

const TREND_COPY: Record<Trend, { color: string; word: string }> = {
  UP:       { color: "text-success", word: "uptrend" },
  DOWN:     { color: "text-danger",   word: "downtrend" },
  SIDEWAYS: { color: "text-txt-secondary", word: "ranging" },
};

export function HigherTimeframeBiasCard({ higherTimeframe, higherTrend, bestBias }: Props) {
  const tc = TREND_COPY[higherTrend.trend];
  const counterHtf =
    (higherTrend.trend === "UP" && bestBias === "SELL") ||
    (higherTrend.trend === "DOWN" && bestBias === "BUY");

  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">Higher timeframe ({higherTimeframe})</div>
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-sm font-semibold ${tc.color}`}>
          {higherTimeframe} is in {tc.word} (strength {higherTrend.strength})
        </span>
        <span className="text-txt-secondary">Suggested bias: <span className="font-semibold text-foreground">{bestBias}</span></span>
      </div>
      {counterHtf && (
        <p className="mt-2 text-warning">
          ⚠ Suggested bias is counter to the higher-timeframe trend. Counter-HTF entries carry elevated reversal risk — consider waiting or reducing size.
        </p>
      )}
    </div>
  );
}
