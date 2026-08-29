import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EmotionAfterTradeSelector } from "./EmotionAfterTradeSelector";
import { LessonLearnedBox } from "./LessonLearnedBox";
import { RecommendedReplayDrillCard } from "./RecommendedReplayDrillCard";
import type { ChecklistAnswer, ChecklistItem, DebriefDraft } from "./types";

const QUESTIONS: ReadonlyArray<{ id: string; q: string }> = [
  { id: "followed_plan",   q: "Did you follow your trade plan?" },
  { id: "respected_stop",  q: "Did you respect your stop loss?" },
  { id: "exited_per_plan", q: "Did you exit according to plan?" },
  { id: "patient_entry",   q: "Was the entry patient (not rushed)?" },
  { id: "emotion_free",    q: "Were you emotion-free during the trade?" },
  { id: "would_repeat",    q: "Is there something you would repeat?" },
  { id: "would_change",    q: "Is there something you would change?" },
];

interface Props { tradeId: number; onClose: () => void; onSaved?: () => void }
interface DebriefResp {
  debrief: { id: number; result: string; aiFeedback: string; recommendedDrill: string };
}

export function PostTradeDebriefModal({ tradeId, onClose, onSaved }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DebriefDraft>({ tradeId, checklist: [] });
  const [savedDebrief, setSavedDebrief] = useState<DebriefResp["debrief"] | null>(null);

  const setAnswer = (id: string, answer: ChecklistAnswer) => {
    const next: ChecklistItem[] = QUESTIONS.map((q) => {
      const existing = draft.checklist.find((c) => c.id === q.id);
      if (q.id === id) return { id, answer };
      return existing ?? { id: q.id, answer: "UNSURE" as ChecklistAnswer };
    });
    setDraft({ ...draft, checklist: next });
  };

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/post-trade-debriefs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json() as Promise<DebriefResp>;
    },
    onSuccess: (d) => {
      setSavedDebrief(d.debrief);
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      onSaved?.();
    },
  });

  const allAnswered = QUESTIONS.every((q) => draft.checklist.find((c) => c.id === q.id) != null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Post-trade debrief</h2>
            <p className="text-[11px] text-txt-secondary">Trade #{tradeId} — fresh-eyes reflection. Coaching aid; not predictive.</p>
          </div>
          <button onClick={onClose} className="rounded px-2 py-0.5 text-xs text-txt-secondary hover:bg-secondary hover:text-foreground">✕</button>
        </div>

        {!savedDebrief ? (
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {QUESTIONS.map((q) => {
                const cur = draft.checklist.find((c) => c.id === q.id)?.answer;
                return (
                  <li key={q.id} className="flex items-center justify-between gap-2 rounded border border-border bg-background/40 p-2 text-xs">
                    <span className="flex-1 text-foreground">{q.q}</span>
                    <div className="flex gap-1">
                      {(["YES","UNSURE","NO"] as const).map((opt) => (
                        <button key={opt} type="button" onClick={() => setAnswer(q.id, opt)}
                          className={`rounded px-2 py-0.5 text-[10px] font-bold transition ${
                            cur === opt
                              ? opt === "YES"  ? "bg-success/15 text-white"
                              : opt === "NO"   ? "bg-danger/15 text-white"
                              : "bg-muted text-foreground"
                              : "bg-secondary text-txt-secondary hover:bg-muted"}`}>{opt}</button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
            <EmotionAfterTradeSelector value={draft.traderEmotionAfter}
              onChange={(v) => setDraft({ ...draft, traderEmotionAfter: v })} />
            <LessonLearnedBox biggestMistake={draft.biggestMistake} biggestStrength={draft.biggestStrength}
              lessonLearned={draft.lessonLearned}
              onChange={(patch) => setDraft({ ...draft, ...patch })} />
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-txt-muted">{allAnswered ? "All questions answered" : `${draft.checklist.length}/${QUESTIONS.length} answered`}</span>
              <button onClick={() => submit.mutate()} disabled={!allAnswered || submit.isPending}
                className="rounded bg-success px-3 py-1.5 text-xs font-semibold text-white hover:bg-success disabled:opacity-40">
                {submit.isPending ? "Saving…" : "Save debrief"}
              </button>
            </div>
            {submit.isError && <p className="text-[11px] text-danger">{(submit.error as Error).message}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border border-success/40 bg-success/30 p-2 text-xs text-success">
              Debrief saved · result <strong>{savedDebrief.result}</strong>
            </div>
            <RecommendedReplayDrillCard drill={savedDebrief.recommendedDrill} feedback={savedDebrief.aiFeedback} />
            <div className="flex justify-end">
              <button onClick={onClose} className="rounded bg-muted px-3 py-1.5 text-xs font-semibold text-white hover:bg-muted">Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
