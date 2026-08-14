import type { WeeklyReview } from "@workspace/api-client-react";

export function MistakeStrengthPatternCards({ r }: { r: WeeklyReview }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Card label="Biggest mistake pattern" tag={r.biggestMistakePattern ?? null} tone="bad" />
      <Card label="Biggest strength pattern" tag={r.biggestStrengthPattern ?? null} tone="good" />
    </div>
  );
}
function Card({ label, tag, tone }: { label: string; tag: string | null; tone: "good" | "bad" }) {
  const ring = tone === "good" ? "ring-emerald-500/30 text-emerald-200" : "ring-rose-500/30 text-rose-200";
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 ring-1 ${ring}`}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-sm">{tag ? humanize(tag) : "None detected"}</div>
    </div>
  );
}
function humanize(t: string) {
  return t.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
