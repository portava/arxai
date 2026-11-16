import { LEVEL_THRESHOLDS, type SkillLevel } from "./types";

const LEVELS: SkillLevel[] = [
  "Beginner", "Developing Trader", "Disciplined Trader",
  "Consistent Trader", "Advanced Trader", "Elite Trader",
];

export function LevelProgressMeter({ total, level }: { total: number; level: SkillLevel }) {
  const pct = Math.max(0, Math.min(100, total));
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-slate-300">Total process score</span>
        <span className="font-mono text-slate-100">{Math.round(total)} / 100</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="h-full bg-gradient-to-r from-slate-500 via-sky-500 to-emerald-500" style={{ width: `${pct}%` }} />
        {LEVELS.slice(1).map((l) => {
          const pos = LEVEL_THRESHOLDS[l];
          return (
            <div key={l} className="absolute top-0 h-full w-px bg-slate-950/70"
              style={{ left: `${pos}%` }} title={`${l} ≥ ${pos}`} />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-slate-500">
        {LEVELS.map((l) => (
          <span key={l} className={l === level ? "font-bold text-slate-200" : ""}>{l.split(" ")[0]}</span>
        ))}
      </div>
    </div>
  );
}
