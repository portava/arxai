// (M) Conflict warning banner shown when alignment label indicates a
// non-clean condition. Non-blocking by design — informs the trader, never
// stops them. The trade-plan checklist surfaces this as a WARN, not a FAIL.

interface Props {
  warning: string | null;
  label: string;
}

const COLOR_BY_LABEL: Record<string, string> = {
  LOWER_TIMEFRAME_CONFLICT: "border-amber-700 bg-amber-950/40 text-amber-200",
  HIGHER_TIMEFRAME_WARNING: "border-orange-700 bg-orange-950/40 text-orange-200",
  MIXED_ALIGNMENT: "border-amber-800 bg-amber-950/30 text-amber-200",
  NO_CLEAR_BIAS: "border-slate-700 bg-slate-900/40 text-slate-400",
};

export function TimeframeConflictWarning({ warning, label }: Props) {
  if (!warning) return null;
  const cls = COLOR_BY_LABEL[label] ?? "border-slate-700 bg-slate-900/40 text-slate-300";
  return (
    <div className={`rounded-md border p-3 text-xs ${cls}`}>
      <div className="mb-1 font-semibold uppercase tracking-wide">⚠ Timeframe warning</div>
      <p>{warning}</p>
    </div>
  );
}
