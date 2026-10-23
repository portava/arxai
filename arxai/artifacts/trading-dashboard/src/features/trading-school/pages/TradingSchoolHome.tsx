/**
 * Trading School — Home. Entry hub: continue learning, the 10-step program,
 * progress, glossary/risk-simulator/labs links, badges, and the woven-in
 * education disclaimer. Reads progress from the local progress layer (swappable
 * for the API later). Renders inside AppLayout (global header/nav provided).
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";
import { RubyAvatar } from "@/components/ruby/RubyAvatar";
import { buildSteps, BADGES, PRACTICE_LABS, buildSchoolDisclaimer } from "../data/content";
import { useSchoolProgress, completionPct } from "../lib/progress";
import { SchoolPageHeader, RubyTeacherCard, SchoolDisclaimer, askRuby } from "../components/SchoolUI";
import {
  GraduationCap, BookOpen, Brain, FlaskConical, Trophy, Calculator,
  ScrollText, ArrowRight, Sparkles, ChevronRight, Award,
} from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

export default function TradingSchoolHome() {
  const { name } = useAssistantName();
  const STEPS = useMemo(() => buildSteps(name), [name]);
  const SCHOOL_DISCLAIMER = useMemo(() => buildSchoolDisclaimer(name), [name]);
  const p = useSchoolProgress();

  const pct = completionPct(p);
  const nextStep = STEPS.find((s) => !p?.passedLessonIds.includes(s.id)) ?? STEPS[0];
  const dailyLesson = STEPS[(new Date().getDate()) % STEPS.length]; // rotates daily, deterministic
  const earnedBadges = BADGES.filter((b) => p?.earnedBadgeIds.includes(b.id));

  const tiles = [
    { href: "/school/program", label: "10-Step Program", icon: BookOpen, desc: "The full beginner course" },
    { href: "/school/glossary", label: "Glossary", icon: ScrollText, desc: "Plain-English trading terms" },
    { href: "/school/risk-simulator", label: "Risk Simulator", icon: Calculator, desc: "Practice position sizing" },
    { href: "/school/labs", label: "Practice Labs", icon: FlaskConical, desc: "Hands-on practice" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-trading-school">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SchoolPageHeader title="Trading School" subtitle={`Learn trading from the ground up with ${name} — clear, calm, and step by step.`} />
        <button onClick={askRuby} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/20">
          <Sparkles className="h-4 w-4" /> Ask {name} to Explain
        </button>
      </div>

      {/* Continue learning + progress */}
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Link href={`/school/lesson/${nextStep.id}`} className="group rounded-2xl border border-primary/30 bg-card p-4 transition-colors hover:border-primary/50">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
            <GraduationCap className="h-4 w-4" /> {p?.startedAt ? "Continue Learning" : "Start Learning"}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-bold">Step {nextStep.number}: {nextStep.title}</div>
              <p className="text-sm text-txt-secondary">{nextStep.blurb}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-primary transition-transform group-hover:translate-x-1" />
          </div>
        </Link>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">My Progress</div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-3xl font-bold text-foreground">{pct}%</span>
            <span className="mb-1 text-xs text-txt-muted">of 10 steps</span>
          </div>
          <Progress value={pct} className="mt-2" />
          <div className="mt-2 text-xs text-txt-muted">
            {p?.passedLessonIds.length ?? 0} passed · {p?.attempts.length ?? 0} quiz attempts
          </div>
          <Link href="/school/progress" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
            View detailed progress <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Ruby's daily lesson */}
      <div className="rounded-2xl border border-ruby/25 bg-card p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ruby">
          <Sparkles className="h-4 w-4" /> {name}'s Daily Lesson
        </div>
        <Link href={`/school/lesson/${dailyLesson.id}`} className="flex items-center justify-between gap-3 group">
          <div className="flex items-center gap-3">
            <RubyAvatar state="thinking" size="md" ariaHidden />
            <div>
              <div className="text-sm font-semibold">Step {dailyLesson.number}: {dailyLesson.title}</div>
              <p className="text-xs text-txt-muted">{dailyLesson.subtitle}</p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-ruby transition-transform group-hover:translate-x-1" />
        </Link>
      </div>

      {/* quick tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
            <t.icon className="h-5 w-5 text-primary" />
            <div className="mt-2 text-sm font-semibold">{t.label}</div>
            <p className="text-xs text-txt-muted">{t.desc}</p>
          </Link>
        ))}
      </div>

      {/* Ruby teaching modes preview (uses Step 5 support example) */}
      <RubyTeacherCard
        title={`${name} teaches at your level`}
        ruby={{
          simple: "Support is like a floor. Price fell there before and bounced. Traders watch it because buyers may defend that area again.",
          normal: "Support is a price zone where buying pressure previously appeared strong enough to stop or slow a drop.",
          pro: "Support is a historically reactive demand zone where order flow previously absorbed selling pressure, often used for entry planning, stop placement, or invalidation.",
        }}
      />

      {/* badges */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary">
            <Trophy className="h-4 w-4 text-warning" /> Certificates & Badges
          </div>
          <span className="text-xs text-txt-muted">{earnedBadges.length}/{BADGES.length} earned</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {BADGES.map((b) => {
            const earned = p?.earnedBadgeIds.includes(b.id);
            return (
              <div key={b.id} className={`rounded-xl border p-3 ${earned ? "border-warning/40 bg-warning/5" : "border-border bg-background/40 opacity-60"}`}>
                <Award className={`h-5 w-5 ${earned ? "text-warning" : "text-txt-muted"}`} />
                <div className="mt-1 text-xs font-semibold text-foreground">{b.label}</div>
                <div className="text-[10px] text-txt-muted">{earned ? "Earned" : "Locked"}</div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-txt-muted">Badges mean education completed only — they are not a financial qualification or a promise of profit.</p>
      </div>

      <div className="rounded-2xl border border-border bg-background/40 p-4">
        <SchoolDisclaimer text={SCHOOL_DISCLAIMER} />
      </div>
    </div>
  );
}
