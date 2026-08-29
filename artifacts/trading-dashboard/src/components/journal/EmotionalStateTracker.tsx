const STATES = ["CALM","FOMO","FEAR","GREED","REVENGE","DISCIPLINED","UNCERTAIN"] as const;

export function EmotionalStateTracker({
  before, after, onChange,
}: { before: string | null; after: string | null; onChange: (next: { before: string | null; after: string | null }) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(["before", "after"] as const).map((k) => {
        const value = k === "before" ? before : after;
        return (
          <div key={k}>
            <div className="mb-1 text-xs uppercase tracking-wide text-txt-muted">Emotion {k}</div>
            <div className="flex flex-wrap gap-1">
              {STATES.map((s) => (
                <button key={s} type="button"
                  onClick={() => onChange({ before: k === "before" ? s : before, after: k === "after" ? s : after })}
                  className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${
                    value === s ? "bg-premium/25 text-premium ring-premium/50"
                                : "bg-card text-txt-secondary ring-border hover:text-foreground"
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
