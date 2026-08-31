/**
 * Trading School — 10-Step Program overview. Lists all 10 steps with status
 * (complete / in-progress / locked) derived from local progress. Steps unlock
 * sequentially: a step is available once the previous one is passed (Step 1
 * always open). Renders inside AppLayout.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";
import { STEPS, buildSchoolDisclaimer } from "../data/content";
import { useSchoolProgress, useSchoolSyncStatus, completionPct, bestScore } from "../lib/progress";
import { SchoolPageHeader, StepStatusPill, SchoolDisclaimer } from "../components/SchoolUI";
import { SchoolSyncNotice } from "../components/SchoolSyncNotice";
import { useAssistantName } from "@/lib/assistant-name";
import { BookOpen, ArrowRight, Lock } from "lucide-react";

export default function TradingSchoolProgram() {
  const { name } = useAssistantName();
  const SCHOOL_DISCLAIMER = useMemo(() => buildSchoolDisclaimer(name), [name]);
  const p = useSchoolProgress();
  const syncStatus = useSchoolSyncStatus();
  const pct = completionPct(p);

  // Sequential locks are derived from passedLessonIds — which, when the
  // server read failed (new device / 401 / offline), is only the LOCAL cache.
  // Confidently re-locking steps the user already passed elsewhere on that
  // unknown state is the CONFIDENT_ABSENT defect; while the sync has failed we
  // stop asserting locks (the lock is a pedagogical nudge, not a safety gate)
  // and the SchoolSyncNotice banner says why.
  const locksTrustworthy = syncStatus !== "failed";
  const isUnlocked = (index: number): boolean => {
    if (index === 0) return true;
    if (!locksTrustworthy) return true;
    const prev = STEPS[index - 1];
    return !!p?.passedLessonIds.includes(prev.id);
  };

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-program">
      <SchoolPageHeader title="10-Step Program" subtitle="From complete beginner to building a real trade plan. Take them in order." icon={BookOpen} />

      {/* Failed-sync notice — the statuses below are local-cache-only while
          this renders, and sequential locks are suspended (see isUnlocked). */}
      <SchoolSyncNotice />

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between text-xs text-txt-muted">
          <span>Overall completion</span><span>{pct}%</span>
        </div>
        <Progress value={pct} className="mt-2" />
      </div>

      <ol className="space-y-3">
        {STEPS.map((s, i) => {
          const passed = p?.passedLessonIds.includes(s.id);
          const completed = p?.completedLessonIds.includes(s.id);
          const unlocked = isUnlocked(i);
          const status = passed ? "complete" : unlocked ? "in-progress" : "locked";
          const best = p ? bestScore(p, s.id) : null;

          const inner = (
            <div className={`rounded-2xl border bg-card p-4 transition-colors ${unlocked ? "border-border hover:border-primary/40" : "border-border opacity-60"}`}>
              <div className="flex items-center gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold ring-1 ${passed ? "bg-success/10 text-success ring-success/30" : unlocked ? "bg-primary/10 text-primary ring-primary/25" : "bg-secondary/40 text-txt-muted ring-border"}`}>
                  {unlocked ? s.number : <Lock className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Step {s.number}: {s.title}</span>
                    <StepStatusPill status={status as any} />
                  </div>
                  <p className="text-xs text-txt-muted">{s.subtitle}</p>
                  {best != null && <p className="mt-0.5 text-[11px] text-txt-muted">Best quiz score: {Math.round(best * 100)}%</p>}
                </div>
                {unlocked && <ArrowRight className="h-4 w-4 shrink-0 text-primary" />}
              </div>
            </div>
          );

          return (
            <li key={s.id}>
              {unlocked ? <Link href={`/school/lesson/${s.id}`}>{inner}</Link> : <div title="Pass the previous step to unlock">{inner}</div>}
            </li>
          );
        })}
      </ol>

      <div className="rounded-2xl border border-border bg-background/40 p-4">
        <SchoolDisclaimer text={SCHOOL_DISCLAIMER} />
      </div>
    </div>
  );
}
