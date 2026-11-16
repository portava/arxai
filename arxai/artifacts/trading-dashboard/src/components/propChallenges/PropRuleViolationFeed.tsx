interface V { type: string; severity: "INFO"|"WARN"|"HARD"; message: string }
export function PropRuleViolationFeed({ violations }: { violations: V[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Rule violations & warnings ({violations.length})</h3>
      {violations.length === 0
        ? <p className="text-xs text-slate-500">No violations or warnings yet.</p>
        : <ul className="max-h-56 space-y-1 overflow-auto text-xs">
            {violations.map((v, i) => (
              <li key={i} className="flex items-start gap-2 rounded border border-slate-800 bg-slate-950/40 p-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  v.severity === "HARD" ? "bg-red-700 text-white"
                  : v.severity === "WARN" ? "bg-amber-700 text-white"
                  : "bg-slate-700 text-slate-200"}`}>{v.severity}</span>
                <span className="font-mono text-[10px] text-slate-400">{v.type}</span>
                <span className="text-slate-200">{v.message}</span>
              </li>
            ))}
          </ul>}
    </div>
  );
}
