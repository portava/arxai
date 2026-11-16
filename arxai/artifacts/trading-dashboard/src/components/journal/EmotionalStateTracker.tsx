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
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Emotion {k}</div>
            <div className="flex flex-wrap gap-1">
              {STATES.map((s) => (
                <button key={s} type="button"
                  onClick={() => onChange({ before: k === "before" ? s : before, after: k === "after" ? s : after })}
                  className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${
                    value === s ? "bg-violet-500/25 text-violet-100 ring-violet-500/50"
                                : "bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200"
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
