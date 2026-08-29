import type { EdgeWarning } from "./types";

const SEV: Record<EdgeWarning["severity"], string> = {
  INFO:   "border-border bg-muted/40 text-txt-secondary",
  WARN:   "border-warning/40 bg-warning/30 text-warning",
  DANGER: "border-danger/40 bg-danger/30 text-danger",
};

export function EdgeWarningPanel({ warnings }: { warnings: EdgeWarning[] }) {
  if (warnings.length === 0) {
    return <p className="rounded border border-dashed border-border p-3 text-center text-[11px] text-txt-muted">No warnings.</p>;
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
