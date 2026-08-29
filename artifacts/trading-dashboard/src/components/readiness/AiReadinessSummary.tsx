type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
const tone: Record<Status, string> = {
  READY:     "border-success/40 bg-success/30 text-success",
  CAUTION:   "border-warning/40 bg-warning/30 text-warning",
  NOT_READY: "border-warning/40 bg-warning/30 text-warning",
  LOCKED:    "border-danger/40 bg-danger/40 text-danger",
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
