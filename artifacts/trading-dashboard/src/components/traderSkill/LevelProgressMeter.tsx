import { LEVEL_THRESHOLDS, type SkillLevel } from "./types";

const LEVELS: SkillLevel[] = [
  "Beginner", "Developing Trader", "Disciplined Trader",
  "Consistent Trader", "Advanced Trader", "Elite Trader",
];

export function LevelProgressMeter({ total, level }: { total: number; level: SkillLevel }) {
  const pct = Math.max(0, Math.min(100, total));
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-txt-secondary">Total process score</span>
        <span className="font-mono text-foreground">{Math.round(total)} / 100</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-gradient-to-r from-muted via-ruby to-success" style={{ width: `${pct}%` }} />
        {LEVELS.slice(1).map((l) => {
          const pos = LEVEL_THRESHOLDS[l];
          return (
            <div key={l} className="absolute top-0 h-full w-px bg-background/70"
              style={{ left: `${pos}%` }} title={`${l} ≥ ${pos}`} />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-txt-muted">
        {LEVELS.map((l) => (
          <span key={l} className={l === level ? "font-bold text-foreground" : ""}>{l.split(" ")[0]}</span>
        ))}
      </div>
    </div>
  );
}
