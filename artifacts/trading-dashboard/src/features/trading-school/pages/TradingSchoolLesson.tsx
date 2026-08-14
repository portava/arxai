/**
 * Trading School — Lesson Detail. The main teaching page: lesson body, Ruby's
 * three-mode teacher card, vocabulary, beginner example, ARX tie-in, the quiz,
 * a practice-lab link, and prev/next navigation. Auto-saves "started" on open
 * and records quiz attempts/completion on submit, all via the local progress
 * layer. Renders inside AppLayout.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { buildSteps } from "../data/content";
import { markLessonStarted, recordQuizAttempt } from "../lib/progress";
import { RubyTeacherCard, SchoolPageHeader, askRuby } from "../components/SchoolUI";
import { LessonQuiz } from "../components/LessonQuiz";
import { useAssistantName } from "@/lib/assistant-name";
import {
  ChevronLeft, ChevronRight, BookOpen, FlaskConical, Sparkles,
  ListChecks, GraduationCap, ArrowLeft,
} from "lucide-react";

export default function TradingSchoolLesson() {
  const { name } = useAssistantName();
  const STEPS = useMemo(() => buildSteps(name), [name]);
  const [, params] = useRoute("/school/lesson/:id");
  const [, navigate] = useLocation();
  const id = params?.id ?? "step-1";
  const index = Math.max(0, STEPS.findIndex((s) => s.id === id));
  const step = STEPS[index];
  const prev = index > 0 ? STEPS[index - 1] : null;
  const next = index < STEPS.length - 1 ? STEPS[index + 1] : null;

  const [tab, setTab] = useState<"lesson" | "quiz">("lesson");

  useEffect(() => {
    if (step) markLessonStarted(step.id);
    setTab("lesson");
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  }, [step?.id]);

  if (!step) {
    return (
      <div className="mx-auto w-full max-w-[800px] p-6">
        <p className="text-sm text-txt-secondary">Lesson not found.</p>
        <Link href="/school/program" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to program
        </Link>
      </div>
    );
  }

  const onQuizComplete = (scorePct: number) => {
    recordQuizAttempt(step.id, scorePct);
  };

  return (
    <div className="mx-auto w-full max-w-[860px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-lesson">
      <Link href="/school/program" className="inline-flex items-center gap-1 text-xs text-txt-muted hover:text-primary">
        <ArrowLeft className="h-3.5 w-3.5" /> 10-Step Program
      </Link>

      <SchoolPageHeader title={`Step ${step.number}: ${step.title}`} subtitle={step.subtitle} icon={GraduationCap} />

      {/* tabs */}
      <div className="flex gap-1 rounded-xl border border-border bg-card p-1">
        {([["lesson", "Lesson", BookOpen], ["quiz", "Quiz", ListChecks]] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === key ? "bg-primary/15 text-primary" : "text-txt-secondary hover:text-foreground"}`}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "lesson" ? (
        <div className="space-y-4">
          {/* lesson body */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            {step.lesson.map((para, i) => (
              <p key={i} className="text-sm leading-relaxed text-txt-secondary">{para}</p>
            ))}
          </div>

          {/* Ruby teacher card with 3 modes */}
          <RubyTeacherCard ruby={step.ruby} />

          {/* beginner example */}
          <div className="rounded-2xl border border-primary/25 bg-card p-4">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
              <Sparkles className="h-4 w-4" /> Beginner Example
            </div>
            <p className="text-sm text-txt-secondary">{step.beginnerExample}</p>
          </div>

          {/* vocabulary */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary">Key Vocabulary</div>
            <dl className="grid gap-2 sm:grid-cols-2">
              {step.vocab.map((v) => (
                <div key={v.term} className="rounded-lg border border-border bg-background/40 p-2.5">
                  <dt className="text-sm font-semibold text-foreground">{v.term}</dt>
                  <dd className="text-xs text-txt-muted">{v.meaning}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* ARX tie-in */}
          <div className="rounded-2xl border border-ruby/25 bg-card p-4">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ruby">In the ARX app</div>
            <p className="text-sm text-txt-secondary">{step.arxTieIn}</p>
          </div>

          {/* practice + take quiz CTAs */}
          <div className="flex flex-wrap gap-2">
            <Link href="/school/labs" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
              <FlaskConical className="h-4 w-4 text-primary" /> Practice this
            </Link>
            <button onClick={() => setTab("quiz")} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary/90">
              <ListChecks className="h-4 w-4" /> Take quiz
            </button>
            <button onClick={askRuby} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/20">
              <Sparkles className="h-4 w-4" /> Ask {name}
            </button>
          </div>
        </div>
      ) : (
        <LessonQuiz questions={step.quiz} onComplete={onQuizComplete} />
      )}

      {/* prev / next */}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        {prev ? (
          <button onClick={() => navigate(`/school/lesson/${prev.id}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
            <ChevronLeft className="h-4 w-4" /> Step {prev.number}
          </button>
        ) : <span />}
        {next ? (
          <button onClick={() => navigate(`/school/lesson/${next.id}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
            Step {next.number} <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <Link href="/school/progress" className="inline-flex items-center gap-1.5 rounded-lg bg-success/15 border border-success/40 px-3 py-2 text-sm font-medium text-success">
            Finish <ChevronRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </div>
  );
}
