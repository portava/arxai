const MISTAKE_TAGS = [
  "EARLY_ENTRY","LATE_ENTRY","REVENGE_TRADE","FOMO_ENTRY","OVERSIZED_POSITION",
  "POOR_STOP_LOSS","MOVED_STOP_LOSS","EXITED_TOO_EARLY","HELD_TOO_LONG",
  "IGNORED_MARKET_CONDITION","STRATEGY_MISMATCH","OVERTRADING",
] as const;

export function MistakeTagsSelector({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (tag: string) => onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  return (
    <div className="space-y-1.5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Mistake tags</div>
      <div className="flex flex-wrap gap-1.5">
        {MISTAKE_TAGS.map((t) => {
          const on = value.includes(t);
          return (
            <button key={t} type="button" onClick={() => toggle(t)}
              className={`rounded-full px-2.5 py-1 text-[11px] ring-1 transition ${
                on ? "bg-rose-500/20 text-rose-200 ring-rose-500/40"
                   : "bg-zinc-900 text-zinc-400 ring-zinc-700 hover:text-zinc-200"
              }`}>
              {humanize(t)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
function humanize(t: string) {
  return t.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
