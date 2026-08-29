// (M) Conflict warning banner shown when alignment label indicates a
// non-clean condition. Non-blocking by design — informs the trader, never
// stops them. The trade-plan checklist surfaces this as a WARN, not a FAIL.

interface Props {
  warning: string | null;
  label: string;
}

const COLOR_BY_LABEL: Record<string, string> = {
  LOWER_TIMEFRAME_CONFLICT: "border-warning/40 bg-warning/40 text-warning",
  HIGHER_TIMEFRAME_WARNING: "border-warning/40 bg-warning/40 text-warning",
  MIXED_ALIGNMENT: "border-warning/40 bg-warning/30 text-warning",
  NO_CLEAR_BIAS: "border-border bg-muted/40 text-txt-secondary",
};

export function TimeframeConflictWarning({ warning, label }: Props) {
  if (!warning) return null;
  const cls = COLOR_BY_LABEL[label] ?? "border-border bg-muted/40 text-txt-secondary";
  return (
    <div className={`rounded-md border p-3 text-xs ${cls}`}>
      <div className="mb-1 font-semibold uppercase tracking-wide">⚠ Timeframe warning</div>
      <p>{warning}</p>
    </div>
  );
}
