type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
const tone: Record<Status, string> = {
  READY:     "border-emerald-700 bg-emerald-950/30 text-emerald-100",
  CAUTION:   "border-amber-700 bg-amber-950/30 text-amber-100",
  NOT_READY: "border-orange-700 bg-orange-950/30 text-orange-100",
  LOCKED:    "border-red-700 bg-red-950/40 text-red-100",
};
export function AiReadinessSummary({ status, summary, blockers, warnings }:
  { status: Status; summary: string; blockers: string[]; warnings: string[] }) {
  return (
    <div className={`rounded-lg border p-4 ${tone[status]}`}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">AI readiness summary</h3>
        <span className="text-[10px] uppercase tracking-wide opacity-70">{status}</span>
      </div>
      <p className="text-xs leading-relaxed">{summary}</p>
      {blockers.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">Blockers</div>
          <ul className="list-disc pl-4 text-[11px]">{blockers.map((b,i)=><li key={i}>{b}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">Warnings</div>
          <ul className="list-disc pl-4 text-[11px]">{warnings.map((b,i)=><li key={i}>{b}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
