const STRENGTH_TAGS = [
  "WAITED_FOR_CONFIRMATION","GOOD_RISK_CONTROL","FOLLOWED_PLAN","STRONG_ENTRY",
  "STRONG_EXIT","AVOIDED_BAD_TRADE","MANAGED_EMOTIONS","RESPECTED_STOP_LOSS",
  "TOOK_VALID_SETUP","PRACTICED_PATIENCE",
] as const;

export function StrengthTagsSelector({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (tag: string) => onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  return (
    <div className="space-y-1.5">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Strength tags</div>
      <div className="flex flex-wrap gap-1.5">
        {STRENGTH_TAGS.map((t) => {
          const on = value.includes(t);
          return (
            <button key={t} type="button" onClick={() => toggle(t)}
              className={`rounded-full px-2.5 py-1 text-[11px] ring-1 transition ${
                on ? "bg-success/20 text-success ring-success/40"
                   : "bg-card text-txt-secondary ring-border hover:text-foreground"
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
