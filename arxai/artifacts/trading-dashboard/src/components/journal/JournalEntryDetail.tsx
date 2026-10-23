import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRichJournalEntry, useUpdateRichJournalEntry,
  getGetRichJournalEntryQueryKey, getListRichJournalEntriesQueryKey,
} from "@workspace/api-client-react";
import { MistakeTagsSelector } from "./MistakeTagsSelector";
import { StrengthTagsSelector } from "./StrengthTagsSelector";
import { EmotionalStateTracker } from "./EmotionalStateTracker";
import { ScreenshotUploadSection } from "./ScreenshotUploadSection";
import { TradeNotesEditor } from "./TradeNotesEditor";
import { AITradeReviewCard } from "./AITradeReviewCard";

// Build I — single-entry editor, composes all the smaller selectors.
export function JournalEntryDetail({ entryId }: { entryId: number }) {
  const qc = useQueryClient();
  const { data } = useGetRichJournalEntry(entryId, { query: { queryKey: getGetRichJournalEntryQueryKey(entryId) } });
  const [draft, setDraft] = useState<{
    mistakeTags: string[]; strengthTags: string[]; screenshots: string[];
    emotionalStateBefore: string | null; emotionalStateAfter: string | null;
    confidenceLevel: number | null;
    userNotes: string; lessonLearned: string; followUpGoal: string;
  } | null>(null);

  useEffect(() => {
    if (!data || draft) return;
    setDraft({
      mistakeTags: data.mistakeTags,
      strengthTags: data.strengthTags,
      screenshots: data.screenshots,
      emotionalStateBefore: data.emotionalStateBefore ?? null,
      emotionalStateAfter: data.emotionalStateAfter ?? null,
      confidenceLevel: data.confidenceLevel ?? null,
      userNotes: data.userNotes ?? "",
      lessonLearned: data.lessonLearned ?? "",
      followUpGoal: data.followUpGoal ?? "",
    });
  }, [data, draft]);

  const update = useUpdateRichJournalEntry({ mutation: {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetRichJournalEntryQueryKey(entryId) });
      qc.invalidateQueries({ queryKey: getListRichJournalEntriesQueryKey() });
    },
  } });

  if (!data || !draft) return <div className="text-xs text-zinc-500">Loading entry…</div>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{data.symbol}</div>
        <div className="text-lg font-semibold text-zinc-100">{data.direction} · {data.strategyUsed ?? "—"}</div>
      </div>
      <AITradeReviewCard entry={data} />
      <EmotionalStateTracker
        before={draft.emotionalStateBefore}
        after={draft.emotionalStateAfter}
        onChange={(n) => setDraft({ ...draft, ...n })} />
      <MistakeTagsSelector value={draft.mistakeTags} onChange={(mistakeTags) => setDraft({ ...draft, mistakeTags })} />
      <StrengthTagsSelector value={draft.strengthTags} onChange={(strengthTags) => setDraft({ ...draft, strengthTags })} />
      <TradeNotesEditor
        notes={draft.userNotes} lessonLearned={draft.lessonLearned}
        followUpGoal={draft.followUpGoal} confidence={draft.confidenceLevel}
        onChange={(n) => setDraft({
          ...draft,
          ...(n.notes !== undefined ? { userNotes: n.notes } : {}),
          ...(n.lessonLearned !== undefined ? { lessonLearned: n.lessonLearned } : {}),
          ...(n.followUpGoal !== undefined ? { followUpGoal: n.followUpGoal } : {}),
          ...(n.confidence !== undefined ? { confidenceLevel: n.confidence } : {}),
        })} />
      <ScreenshotUploadSection value={draft.screenshots} onChange={(screenshots) => setDraft({ ...draft, screenshots })} />
      <div className="flex justify-end">
        <button type="button" disabled={update.isPending}
          onClick={() => update.mutate({ id: entryId, data: { ...draft, symbol: data.symbol, direction: data.direction } })}
          className="rounded-md bg-emerald-500/80 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {update.isPending ? "Saving…" : "Save entry"}
        </button>
      </div>
    </div>
  );
}
