/**
 * Trading School — My Progress. Detailed view of completion, quiz history,
 * earned badges, and key dates. Includes a reset for re-taking the course.
 * Reads from the local progress layer. Renders inside AppLayout.
 */
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";
import { STEPS, BADGES } from "../data/content";
import { useSchoolProgress, completionPct, bestScore, resetProgress } from "../lib/progress";
import { SchoolPageHeader } from "../components/SchoolUI";
import { SchoolSyncNotice } from "../components/SchoolSyncNotice";
import { Trophy, Award, RotateCcw, CheckCircle2, Circle } from "lucide-react";

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return "—"; }
}

export default function TradingSchoolProgress() {
  const p = useSchoolProgress();
  const pct = completionPct(p);

  const doReset = () => {
    if (typeof window !== "undefined" && !window.confirm("Reset all Trading School progress? This clears your completed steps, quiz history, and badges.")) return;
    resetProgress();
  };

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-progress">
      <SchoolPageHeader title="My Progress" subtitle="Your journey through Trading School." icon={Trophy} />

      {/* Failed-sync notice — completion, "Not attempted" labels and dates
          below are local-cache-only while this renders. */}
      <SchoolSyncNotice />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-4 sm:col-span-2">
          <div className="flex items-center justify-between text-xs text-txt-muted"><span>Overall completion</span><span>{pct}%</span></div>
          <Progress value={pct} className="mt-2" />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-lg font-bold text-foreground">{p?.passedLessonIds.length ?? 0}</div><div className="text-[11px] text-txt-muted">Steps passed</div></div>
            <div><div className="text-lg font-bold text-foreground">{p?.attempts.length ?? 0}</div><div className="text-[11px] text-txt-muted">Quiz attempts</div></div>
            <div><div className="text-lg font-bold text-foreground">{p?.earnedBadgeIds.length ?? 0}</div><div className="text-[11px] text-txt-muted">Badges</div></div>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">Key dates</div>
          <div className="mt-2 flex justify-between"><span className="text-txt-secondary">Started</span><span className="text-foreground">{fmtDate(p?.startedAt ?? null)}</span></div>
          <div className="mt-1 flex justify-between"><span className="text-txt-secondary">Completed</span><span className="text-foreground">{fmtDate(p?.completedAt ?? null)}</span></div>
        </div>
      </div>

      {/* per-step list */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary">Steps</div>
        <ul className="divide-y divide-border/60">
          {STEPS.map((s) => {
            const passed = p?.passedLessonIds.includes(s.id);
            const best = p ? bestScore(p, s.id) : null;
            return (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <Link href={`/school/lesson/${s.id}`} className="flex items-center gap-2 text-sm hover:text-primary">
                  {passed ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Circle className="h-4 w-4 text-txt-muted" />}
                  Step {s.number}: {s.title}
                </Link>
                <span className="text-xs text-txt-muted">{best != null ? `Best ${Math.round(best * 100)}%` : "Not attempted"}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* badges */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary"><Award className="h-4 w-4 text-warning" /> Badges</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {BADGES.map((b) => {
            const earned = p?.earnedBadgeIds.includes(b.id);
            return (
              <div key={b.id} className={`rounded-xl border p-3 ${earned ? "border-warning/40 bg-warning/5" : "border-border bg-background/40 opacity-60"}`} title={b.note}>
                <Award className={`h-5 w-5 ${earned ? "text-warning" : "text-txt-muted"}`} />
                <div className="mt-1 text-xs font-semibold text-foreground">{b.label}</div>
                <div className="text-[10px] text-txt-muted">{earned ? "Earned" : "Locked"}</div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-txt-muted">Badges reflect education completed only — not a financial qualification or a promise of profit.</p>
      </div>

      <button onClick={doReset} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-txt-secondary hover:border-danger/40 hover:text-danger">
        <RotateCcw className="h-4 w-4" /> Reset progress
      </button>
    </div>
  );
}
