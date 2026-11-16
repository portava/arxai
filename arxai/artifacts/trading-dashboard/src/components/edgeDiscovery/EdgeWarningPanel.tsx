import type { EdgeWarning } from "./types";

const SEV: Record<EdgeWarning["severity"], string> = {
  INFO:   "border-slate-700 bg-slate-900/40 text-slate-300",
  WARN:   "border-amber-700 bg-amber-950/30 text-amber-100",
  DANGER: "border-red-700 bg-red-950/30 text-red-100",
};

export function EdgeWarningPanel({ warnings }: { warnings: EdgeWarning[] }) {
  if (warnings.length === 0) {
    return <p className="rounded border border-dashed border-slate-700 p-3 text-center text-[11px] text-slate-500">No warnings.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {warnings.map((w) => (
        <li key={w.id} className={`rounded border p-2 text-xs ${SEV[w.severity]}`}>
          <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide">{w.warningType.replaceAll("_"," ")}</div>
          <p className="leading-relaxed">{w.message}</p>
        </li>
      ))}
    </ul>
  );
}
