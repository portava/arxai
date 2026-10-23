export function PropPassFailBanner({ status, reason }: { status: string; reason?: string | null }) {
  const tone =
    status === "PASSED" ? "border-emerald-600 bg-emerald-950/40 text-emerald-200" :
    status === "FAILED" ? "border-red-600 bg-red-950/40 text-red-200" :
    status === "PAUSED" ? "border-amber-600 bg-amber-950/40 text-amber-200" :
    status === "CANCELED" ? "border-slate-600 bg-slate-900/60 text-slate-300" :
    "border-sky-600 bg-sky-950/40 text-sky-200";
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">{status}</h3>
        <span className="rounded bg-amber-700 px-2 py-0.5 text-[10px] font-bold text-white">SIMULATED — PRACTICE ONLY</span>
      </div>
      {reason && <p className="mt-1 text-xs">{reason}</p>}
      <p className="mt-2 text-[11px] opacity-80">Practice/training only. Does not promise funded-account approval or guaranteed profits.</p>
    </div>
  );
}
