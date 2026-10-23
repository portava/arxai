const STRENGTH_TAGS = [
  "WAITED_FOR_CONFIRMATION","GOOD_RISK_CONTROL","FOLLOWED_PLAN","STRONG_ENTRY",
  "STRONG_EXIT","AVOIDED_BAD_TRADE","MANAGED_EMOTIONS","RESPECTED_STOP_LOSS",
  "TOOK_VALID_SETUP","PRACTICED_PATIENCE",
] as const;

export function StrengthTagsSelector({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (tag: string) => onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  return (
    <div className="space-y-1.5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Strength tags</div>
      <div className="flex flex-wrap gap-1.5">
        {STRENGTH_TAGS.map((t) => {
          const on = value.includes(t);
          return (
            <button key={t} type="button" onClick={() => toggle(t)}
              className={`rounded-full px-2.5 py-1 text-[11px] ring-1 transition ${
                on ? "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40"
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
