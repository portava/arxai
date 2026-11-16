/**
 * ScenarioQuizLab — steps through a lab's practice scenarios one at a time:
 * pick an answer, get instant right/wrong feedback with a short explanation,
 * then a score at the end with "Try again". Scoring is the pure
 * scoreScenarioQuiz helper; persistence is delegated to onComplete.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { EleanorAvatar } from "@/components/eleanor/EleanorAvatar";
import type { ScenarioLab } from "../../data/labs";
import { scoreScenarioQuiz } from "../../lib/labMath";
import { PASS_THRESHOLD } from "../../lib/progress";
import { PracticeChart } from "../PracticeChart";
import { CheckCircle2, XCircle, RotateCcw, ArrowRight } from "lucide-react";

export function ScenarioQuizLab({ lab, onComplete }: { lab: ScenarioLab; onComplete?: (pct: number) => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | undefined)[]>([]);
  const [finished, setFinished] = useState(false);

  const total = lab.scenarios.length;
  const scenario = lab.scenarios[index];
  const chosen = answers[index];
  const answered = chosen !== undefined;
  const score = scoreScenarioQuiz(lab.scenarios, answers);

  const choose = (oi: number) => {
    if (answered) return;
    setAnswers((a) => { const n = [...a]; n[index] = oi; return n; });
  };
  const next = () => {
    if (index < total - 1) setIndex(index + 1);
    else { setFinished(true); onComplete?.(score.pct); }
  };
  const retry = () => { setAnswers([]); setIndex(0); setFinished(false); };

  if (finished) {
    const good = score.pct >= PASS_THRESHOLD;
    return (
      <div className="space-y-3" data-testid="lab-quiz-result">
        <div className={cn("rounded-2xl border p-4", good ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10")}>
          <div className="flex items-center gap-3">
            <EleanorAvatar state={good ? "success" : "thinking"} size="md" ariaHidden />
            <div className="min-w-0">
              <div className={cn("text-sm font-semibold", good ? "text-success" : "text-warning")} data-testid="lab-quiz-score">
                {score.correct}/{score.total} correct ({Math.round(score.pct * 100)}%)
              </div>
              <p className="text-xs text-txt-secondary">
                {good ? "Strong read. Try again any time to keep it sharp." : "Practice makes this automatic. Review the misses below, then try again."}
              </p>
            </div>
          </div>
        </div>
        <ol className="space-y-2">
          {lab.scenarios.map((s, i) => {
            const ok = answers[i] === s.answerIndex;
            return (
              <li key={s.id} className="flex items-start gap-2 rounded-xl border border-border bg-card p-3">
                {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-foreground">{s.prompt}</div>
                  {!ok && <div className="mt-1 text-txt-secondary">Answer: {s.options[s.answerIndex]}. {s.explanation}</div>}
                </div>
              </li>
            );
          })}
        </ol>
        <button onClick={retry} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/40">
          <RotateCcw className="h-4 w-4" /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="lab-quiz">
      <div className="flex items-center justify-between text-xs text-txt-muted">
        <span>Scenario {index + 1} of {total}</span>
        <span>{score.correct} correct so far</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary/60">
        <div className="h-full bg-primary transition-all" style={{ width: `${((index + (answered ? 1 : 0)) / total) * 100}%` }} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <p className="text-sm font-medium text-foreground" data-testid="lab-quiz-prompt">{scenario.prompt}</p>
        {scenario.chart && (
          <div className="rounded-xl border border-border bg-background/40 p-2">
            <PracticeChart
              candles={scenario.chart.candles}
              highlight={scenario.chart.highlight}
              smaPeriod={scenario.chart.smaPeriod}
              levels={scenario.chart.levels}
              lowerPane={scenario.chart.lowerPane}
              height={scenario.chart.lowerPane ? 300 : 220}
              ariaLabel="Practice chart for this scenario"
            />
            {scenario.chart.smaPeriod && <p className="px-1 pt-1 text-[11px] text-txt-muted">Dashed line: {scenario.chart.smaPeriod}-period moving average of closes.</p>}
          </div>
        )}
        <div className="space-y-1.5">
          {scenario.options.map((opt, oi) => {
            const selected = chosen === oi;
            const right = answered && oi === scenario.answerIndex;
            const wrong = answered && selected && oi !== scenario.answerIndex;
            return (
              <button key={oi} disabled={answered} onClick={() => choose(oi)}
                data-testid={`lab-option-${oi}`}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  right ? "border-success/50 bg-success/10 text-success"
                  : wrong ? "border-danger/50 bg-danger/10 text-danger"
                  : "border-border bg-background/40 text-txt-secondary hover:border-primary/30",
                  answered && !right && !wrong && "opacity-60",
                )}>
                {right && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                {wrong && <XCircle className="h-4 w-4 shrink-0" />}
                <span>{opt}</span>
              </button>
            );
          })}
        </div>
        {answered && (
          <div className={cn("rounded-lg border p-3 text-xs", chosen === scenario.answerIndex ? "border-success/40 bg-success/5" : "border-warning/40 bg-warning/5")} data-testid="lab-feedback">
            <div className={cn("mb-1 font-semibold", chosen === scenario.answerIndex ? "text-success" : "text-warning")}>
              {chosen === scenario.answerIndex ? "Correct" : "Not quite"}
            </div>
            <p className="text-txt-secondary">{scenario.explanation}</p>
          </div>
        )}
      </div>

      <button onClick={next} disabled={!answered} data-testid="lab-next"
        className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold",
          answered ? "bg-primary text-white hover:bg-primary/90" : "cursor-not-allowed border border-border bg-background/40 text-txt-muted")}>
        {index < total - 1 ? "Next scenario" : "See my score"} <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
