import type { PlaybookEntry } from "./types";

const TYPE_TONE: Record<string, string> = {
  BEST_SETUP:        "border-success/40 bg-success/30",
  STRENGTH_PATTERN:  "border-success/40 bg-success/30",
  AVOID_SETUP:       "border-danger/40 bg-danger/30",
  MISTAKE_PATTERN:   "border-danger/40 bg-danger/30",
  RULE:              "border-ruby/40 bg-ruby/30",
  RISK_RULE:         "border-warning/40 bg-warning/30",
  EXIT_RULE:         "border-ruby/40 bg-ruby/30",
  ENTRY_RULE:        "border-ruby/40 bg-ruby/30",
  MARKET_CONDITION:  "border-border bg-muted/40",
  SESSION_NOTE:      "border-border bg-muted/40",
};

interface Props { entry: PlaybookEntry; onToggle?: (id: number, next: boolean) => void }

export function PlaybookEntryCard({ entry, onToggle }: Props) {
  const tone = TYPE_TONE[entry.entryType] ?? "border-border bg-muted/40";
  const dim = entry.isActive ? "" : "opacity-50";
  return (
    <div className={`rounded-lg border p-2.5 text-xs ${tone} ${dim}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-txt-secondary">
              {entry.entryType.replaceAll("_", " ")}
            </span>
            <span className="text-[10px] text-txt-muted">conf {Math.round(entry.confidenceScore)}</span>
            <span className="text-[10px] text-txt-muted">· {entry.source.toLowerCase()}</span>
          </div>
          <h4 className="text-sm font-semibold text-foreground">{entry.title}</h4>
          {entry.description && <p className="mt-0.5 text-[11px] leading-relaxed text-txt-secondary">{entry.description}</p>}
        </div>
        {onToggle && (
          <button onClick={() => onToggle(entry.id, !entry.isActive)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              entry.isActive ? "bg-success/15 text-white hover:bg-success"
                             : "bg-muted text-txt-secondary hover:bg-muted"}`}>
            {entry.isActive ? "active" : "off"}
          </button>
        )}
      </div>
    </div>
  );
}
