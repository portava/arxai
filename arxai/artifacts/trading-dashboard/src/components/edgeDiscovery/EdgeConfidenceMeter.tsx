export function EdgeConfidenceMeter({ score, sampleSize }: { score: number; sampleSize: number }) {
  const tone = score >= 70 ? "bg-emerald-500"
              : score >= 50 ? "bg-sky-500"
              : score >= 30 ? "bg-amber-500"
              : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>Edge confidence</span>
        <span className="font-mono">{Math.round(score)} / 100 · n={sampleSize}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${Math.min(100, Math.max(0, score))}%` }} />
      </div>
      <p className="text-[10px] italic text-slate-500">
        Confidence grows with sample size and consistency. Not a predictor of future trades.
      </p>
    </div>
  );
}
