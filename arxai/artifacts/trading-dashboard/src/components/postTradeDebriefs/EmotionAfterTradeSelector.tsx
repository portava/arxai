const EMOTIONS = [
  { value: "CALM",         label: "Calm",         icon: "🧘" },
  { value: "RELIEVED",     label: "Relieved",     icon: "😮‍💨" },
  { value: "NEUTRAL",      label: "Neutral",      icon: "😐" },
  { value: "EUPHORIC",     label: "Euphoric",     icon: "🤩" },
  { value: "DISAPPOINTED", label: "Disappointed", icon: "😞" },
  { value: "FRUSTRATED",   label: "Frustrated",   icon: "😤" },
  { value: "ANXIOUS",      label: "Anxious",      icon: "😰" },
] as const;

export function EmotionAfterTradeSelector({ value, onChange }:
  { value?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-slate-200">Emotion after the trade</div>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
        {EMOTIONS.map((e) => {
          const sel = value === e.value;
          return (
            <button key={e.value} type="button" onClick={() => onChange(e.value)}
              className={`flex flex-col items-center rounded border px-1 py-1.5 text-[10px] transition ${
                sel ? "border-sky-500 bg-sky-950/60 text-sky-100"
                    : "border-slate-700 bg-slate-950/40 text-slate-300 hover:border-slate-500"}`}>
              <span className="text-lg leading-none">{e.icon}</span>
              <span className="mt-0.5">{e.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
