import type { WeeklyReview } from "@workspace/api-client-react";

export function BestWorstTradeCards({ r }: { r: WeeklyReview }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Card label="Best trade" id={r.bestTradeId} strategy={r.bestStrategy} session={r.bestSession} tone="good" />
      <Card label="Worst trade" id={r.worstTradeId} strategy={r.worstStrategy} session={r.worstSession} tone="bad" />
    </div>
  );
}
function Card({ label, id, strategy, session, tone }: {
  label: string; id: number | null | undefined;
  strategy: string | null | undefined; session: string | null | undefined;
  tone: "good" | "bad";
}) {
  const ring = tone === "good" ? "ring-success/30" : "ring-danger/30";
  return (
    <div className={`rounded-xl border border-border bg-background/50 p-3 ring-1 ${ring}`}>
      <div className="text-xs uppercase tracking-wide text-txt-muted">{label}</div>
      <div className="mt-1 text-sm text-foreground">
        Trade #{id ?? "—"} · {strategy ?? "—"}
      </div>
      <div className="text-[11px] text-txt-muted">{session ?? "—"} session</div>
    </div>
  );
}
