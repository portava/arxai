export function TradeNotesEditor({
  notes, lessonLearned, followUpGoal, confidence, onChange,
}: {
  notes: string; lessonLearned: string; followUpGoal: string; confidence: number | null;
  onChange: (next: { notes?: string; lessonLearned?: string; followUpGoal?: string; confidence?: number | null }) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Confidence ({confidence ?? "—"})</div>
        <input type="range" min={0} max={100} value={confidence ?? 50} onChange={(e) => onChange({ confidence: Number(e.target.value) })} className="w-full" />
      </label>
      <label className="block">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Notes</div>
        <textarea rows={4} value={notes} onChange={(e) => onChange({ notes: e.target.value })} className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
      </label>
      <label className="block">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Lesson learned</div>
        <textarea rows={2} value={lessonLearned} onChange={(e) => onChange({ lessonLearned: e.target.value })} className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
      </label>
      <label className="block">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Follow-up goal</div>
        <input value={followUpGoal} onChange={(e) => onChange({ followUpGoal: e.target.value })} className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
      </label>
    </div>
  );
}
