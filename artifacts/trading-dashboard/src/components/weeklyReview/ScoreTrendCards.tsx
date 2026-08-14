import type { WeeklyReview } from "@workspace/api-client-react";

const AREAS: Array<{ key: keyof NonNullable<WeeklyReview["scoreTrends"]>; label: string }> = [
  { key: "discipline", label: "Discipline" },
  { key: "execution", label: "Execution" },
  { key: "emotionalControl", label: "Emotional control" },
  { key: "consistency", label: "Consistency" },
];

export function ScoreTrendCards({ r }: { r: WeeklyReview }) {
  const t = r.scoreTrends ?? { discipline: 0, execution: 0, emotionalControl: 0, consistency: 0 };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {AREAS.map(({ key, label }) => {
        const v = t[key] ?? 0;
        const tone = v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-zinc-300";
        return (
          <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
            <div className={`text-lg font-semibold ${tone}`}>{v > 0 ? `+${v}` : v}</div>
          </div>
        );
      })}
    </div>
  );
}
