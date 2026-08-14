interface Props {
  biggestMistake?: string; biggestStrength?: string; lessonLearned?: string;
  onChange: (patch: { biggestMistake?: string; biggestStrength?: string; lessonLearned?: string }) => void;
}
export function LessonLearnedBox({ biggestMistake, biggestStrength, lessonLearned, onChange }: Props) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-200">One thing I did well</span>
        <input value={biggestStrength ?? ""} onChange={(e)=>onChange({biggestStrength:e.target.value})}
          maxLength={500} placeholder="e.g. waited for confirmation"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-200">One thing I'd change</span>
        <input value={biggestMistake ?? ""} onChange={(e)=>onChange({biggestMistake:e.target.value})}
          maxLength={500} placeholder="e.g. moved my stop"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-200">Lesson learned (one sentence)</span>
        <textarea value={lessonLearned ?? ""} onChange={(e)=>onChange({lessonLearned:e.target.value})}
          rows={2} maxLength={500}
          placeholder="What will future-you take from this trade?"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
      </label>
    </div>
  );
}
