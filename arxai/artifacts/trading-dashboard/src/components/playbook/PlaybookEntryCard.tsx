import type { PlaybookEntry } from "./types";

const TYPE_TONE: Record<string, string> = {
  BEST_SETUP:        "border-emerald-700 bg-emerald-950/30",
  STRENGTH_PATTERN:  "border-emerald-700 bg-emerald-950/30",
  AVOID_SETUP:       "border-red-700 bg-red-950/30",
  MISTAKE_PATTERN:   "border-red-700 bg-red-950/30",
  RULE:              "border-sky-700 bg-sky-950/30",
  RISK_RULE:         "border-amber-700 bg-amber-950/30",
  EXIT_RULE:         "border-sky-700 bg-sky-950/30",
  ENTRY_RULE:        "border-sky-700 bg-sky-950/30",
  MARKET_CONDITION:  "border-slate-700 bg-slate-900/40",
  SESSION_NOTE:      "border-slate-700 bg-slate-900/40",
};

interface Props { entry: PlaybookEntry; onToggle?: (id: number, next: boolean) => void }

export function PlaybookEntryCard({ entry, onToggle }: Props) {
  const tone = TYPE_TONE[entry.entryType] ?? "border-slate-700 bg-slate-900/40";
  const dim = entry.isActive ? "" : "opacity-50";
  return (
    <div className={`rounded-lg border p-2.5 text-xs ${tone} ${dim}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-300">
              {entry.entryType.replaceAll("_", " ")}
            </span>
            <span className="text-[10px] text-slate-500">conf {Math.round(entry.confidenceScore)}</span>
            <span className="text-[10px] text-slate-500">· {entry.source.toLowerCase()}</span>
          </div>
          <h4 className="text-sm font-semibold text-slate-100">{entry.title}</h4>
          {entry.description && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-300">{entry.description}</p>}
        </div>
        {onToggle && (
          <button onClick={() => onToggle(entry.id, !entry.isActive)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              entry.isActive ? "bg-emerald-700 text-white hover:bg-emerald-600"
                             : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
            {entry.isActive ? "active" : "off"}
          </button>
        )}
      </div>
    </div>
  );
}
