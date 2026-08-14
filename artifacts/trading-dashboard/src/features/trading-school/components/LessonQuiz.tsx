/**
 * LessonQuiz — runs a lesson's quiz, scores it, and on failure shows Ruby's
 * plain-English explanation for each missed question. Pure presentation +
 * local scoring; persistence is delegated to lib/progress via the onComplete
 * callback so this component stays storage-agnostic.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { RubyAvatar } from "@/components/ruby/RubyAvatar";
import { PASS_THRESHOLD } from "../lib/progress";
import type { QuizQuestion } from "../data/content";
import { CheckCircle2, XCircle, RotateCcw } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

export function LessonQuiz({
  questions, onComplete,
}: {
  questions: QuizQuestion[];
  onComplete?: (scorePct: number, passed: boolean) => void;
}) {
  const { name } = useAssistantName();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);

  const total = questions.length;
  const answeredCount = Object.keys(answers).length;
  const correctCount = questions.filter((q) => answers[q.id] === q.answerIndex).length;
  const scorePct = total > 0 ? correctCount / total : 0;
  const passed = scorePct >= PASS_THRESHOLD;

  const submit = () => {
    setSubmitted(true);
    onComplete?.(scorePct, passed);
  };
  const retry = () => { setAnswers({}); setSubmitted(false); };

  return (
    <div className="space-y-4">
      {!submitted && (
        <div className="flex items-center justify-between text-xs text-txt-muted">
          <span>Answer all {total} questions. You need {Math.round(PASS_THRESHOLD * 100)}% to pass.</span>
          <span>{answeredCount}/{total} answered</span>
        </div>
      )}

      {submitted && (
        <div className={cn("rounded-2xl border p-4", passed ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10")}>
          <div className="flex items-center gap-3">
            <RubyAvatar state={passed ? "success" : "alert"} size="md" ariaHidden />
            <div>
              <div className={cn("text-sm font-semibold", passed ? "text-success" : "text-warning")}>
                {passed ? "Passed!" : "Not quite yet"} — {correctCount}/{total} correct ({Math.round(scorePct * 100)}%)
              </div>
              <p className="text-xs text-txt-secondary">
                {passed
                  ? "Nice work. This step is now marked complete. Review anything below, then move on."
                  : `You need ${Math.round(PASS_THRESHOLD * 100)}% to pass. Read ${name}'s notes on the ones you missed, then retry — there's no penalty for trying again.`}
              </p>
            </div>
          </div>
        </div>
      )}

      <ol className="space-y-4">
        {questions.map((q, idx) => {
          const chosen = answers[q.id];
          const isCorrect = chosen === q.answerIndex;
          return (
            <li key={q.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-2 flex items-start gap-2">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-secondary/60 text-[11px] font-semibold text-txt-secondary">{idx + 1}</span>
                <p className="text-sm font-medium text-foreground">{q.prompt}</p>
              </div>
              <div className="ml-7 space-y-1.5">
                {q.options.map((opt, oi) => {
                  const selected = chosen === oi;
                  const showRight = submitted && oi === q.answerIndex;
                  const showWrong = submitted && selected && oi !== q.answerIndex;
                  return (
                    <button key={oi} disabled={submitted}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: oi }))}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                        showRight ? "border-success/50 bg-success/10 text-success"
                        : showWrong ? "border-danger/50 bg-danger/10 text-danger"
                        : selected ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-background/40 text-txt-secondary hover:border-primary/30",
                      )}>
                      {showRight && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                      {showWrong && <XCircle className="h-4 w-4 shrink-0" />}
                      <span>{opt}</span>
                    </button>
                  );
                })}
              </div>
              {submitted && !isCorrect && (
                <div className="ml-7 mt-2 flex items-start gap-2 rounded-lg border border-ruby/25 bg-ruby/5 p-2.5">
                  <RubyAvatar state="thinking" size="xs" ariaHidden />
                  <p className="text-xs text-txt-secondary"><span className="font-semibold text-ruby">{name}:</span> {q.rubyWhy}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex items-center gap-2">
        {!submitted ? (
          <button onClick={submit} disabled={answeredCount < total}
            className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold",
              answeredCount < total ? "cursor-not-allowed border border-border bg-background/40 text-txt-muted" : "bg-primary text-white hover:bg-primary/90")}>
            Submit quiz
          </button>
        ) : (
          <button onClick={retry} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/40">
            <RotateCcw className="h-4 w-4" /> Retry quiz
          </button>
        )}
      </div>
    </div>
  );
}
