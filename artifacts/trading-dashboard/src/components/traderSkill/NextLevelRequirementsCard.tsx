import type { SkillSuggestion } from "./types";

export function NextLevelRequirementsCard({ suggestions }: { suggestions: SkillSuggestion[] }) {
  const header = suggestions.find((s) => s.area === "NEXT_LEVEL" || s.area === "AT_TOP" || s.area === "GETTING_STARTED");
  const items  = suggestions.filter((s) => s !== header);
  return (
    <div className="rounded-lg border border-violet-700 bg-violet-950/20 p-3">
      <h3 className="mb-1 text-sm font-semibold text-violet-200">Next level requirements</h3>
      {header && <p className="mb-2 text-xs leading-relaxed text-slate-100">{header.message}</p>}
      {items.length > 0 && (
        <>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Biggest leverage points</p>
          <ul className="space-y-1.5">
            {items.map((s, i) => (
              <li key={i} className="rounded border border-slate-800 bg-slate-950/40 p-2 text-xs">
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="font-semibold text-slate-200">{s.area}</span>
                  {s.score !== undefined && <span className="font-mono text-[10px] text-slate-400">{s.score}/100</span>}
                </div>
                <p className="text-[11px] text-slate-300">{s.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
