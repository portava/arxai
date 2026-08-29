import type { TraderSkillProfile } from "./types";

interface Row { label: string; score: number }

function ScoreBar({ row }: { row: Row }) {
  const pct = Math.max(0, Math.min(100, row.score));
  const tone = pct >= 75 ? "bg-success"
             : pct >= 60 ? "bg-ruby"
             : pct >= 45 ? "bg-warning"
             : "bg-danger";
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[10px] text-txt-secondary">
        <span>{row.label}</span>
        <span className="font-mono">{Math.round(pct)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SkillBreakdownCard({ profile }: { profile: TraderSkillProfile }) {
  const rows: Row[] = [
    { label: "Discipline",        score: profile.disciplineScore },
    { label: "Execution",         score: profile.executionScore },
    { label: "Risk control",      score: profile.riskScore },
    { label: "Emotional control", score: profile.emotionalControlScore },
    { label: "Consistency",       score: profile.consistencyScore },
    { label: "Planning",          score: profile.planningScore },
    { label: "Review cadence",    score: profile.reviewScore },
    { label: "Practice",          score: profile.practiceScore },
  ];
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Skill breakdown</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => <ScoreBar key={r.label} row={r} />)}
      </div>
      <p className="mt-2 text-[10px] italic text-txt-muted">
        Equal-weighted across 8 process pillars. Sample-capped — thin evidence cannot produce a high score.
      </p>
    </div>
  );
}
