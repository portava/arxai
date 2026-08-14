interface Item { id: string; label: string; status: "PASS"|"WARN"|"FAIL"|"INFO"; detail: string }
const dot = (s: Item["status"]) =>
  s === "PASS" ? "bg-emerald-500" : s === "WARN" ? "bg-amber-500"
  : s === "FAIL" ? "bg-red-500" : "bg-slate-500";
const tone = (s: Item["status"]) =>
  s === "PASS" ? "text-emerald-300" : s === "WARN" ? "text-amber-300"
  : s === "FAIL" ? "text-red-300" : "text-slate-300";

export function PreSessionChecklist({ items }: { items: Item[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Pre-session checklist</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 rounded border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <span className={`mt-1 inline-block size-2 shrink-0 rounded-full ${dot(it.status)}`} />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-100">{it.label}</span>
                <span className={`font-mono text-[10px] ${tone(it.status)}`}>{it.status}</span>
              </div>
              <div className="text-[11px] text-slate-400">{it.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
