export function PropPassFailBanner({ status, reason }: { status: string; reason?: string | null }) {
  const tone =
    status === "PASSED" ? "border-success bg-success/40 text-success" :
    status === "FAILED" ? "border-danger bg-danger/40 text-danger" :
    status === "PAUSED" ? "border-warning bg-warning/40 text-warning" :
    status === "CANCELED" ? "border-border bg-muted/60 text-txt-secondary" :
    "border-ruby bg-ruby/40 text-ruby";
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">{status}</h3>
        <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-white">SIMULATED — PRACTICE ONLY</span>
      </div>
      {reason && <p className="mt-1 text-xs">{reason}</p>}
      <p className="mt-2 text-[11px] opacity-80">Practice/training only. Does not promise funded-account approval or guaranteed profits.</p>
    </div>
  );
}
