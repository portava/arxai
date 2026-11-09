export interface SelfReport {
  mentalState: number | null; sleepQuality: number | null;
  stressLevel: number | null; confidenceLevel: number | null;
  strategyReady: boolean; riskRulesConfirmed: boolean;
}
interface Props { value: SelfReport; onChange: (v: SelfReport) => void }

// A scale the trader has not answered shows "Not answered" with no point
// selected. It never shows a default value: the server only fails the mental
// check when a field is missing, so an invented value would read as a PASS.
const POINTS = [1, 2, 3, 4, 5] as const;

function Scale({ label, value, onChange, lo, hi }:
  { label: string; value: number | null; onChange: (n: number) => void; lo: string; hi: string }) {
  return (
    <div className="block space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className={`font-mono ${value == null ? "text-amber-400" : "text-slate-500"}`}>
          {value == null ? "Not answered" : `${value}/5`}
        </span>
      </div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-5 gap-1">
        {POINTS.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n}
            aria-label={`${label} ${n} of 5`} onClick={() => onChange(n)}
            className={`rounded border px-1 py-0.5 text-[11px] font-mono ${value === n
              ? "border-sky-500 bg-sky-600/30 text-sky-100"
              : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500"}`}>
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-500"><span>{lo}</span><span>{hi}</span></div>
    </div>
  );
}

export function MentalStateCheckIn({ value, onChange }: Props) {
  const unanswered = [value.mentalState, value.sleepQuality, value.stressLevel, value.confidenceLevel]
    .filter((v) => v == null).length;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-100">Mental check-in</h3>
      <p className="text-[11px] text-slate-400">Honest self-assessment. No score is "wrong" — this just shapes today's plan.</p>
      {unanswered > 0 && (
        <p className="text-[11px] text-amber-300" data-testid="mental-checkin-unanswered">
          {unanswered} of 4 not answered yet. The mental check stays failed until all four are answered.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Scale label="Mental state"      value={value.mentalState}     lo="off"   hi="sharp"   onChange={(n)=>onChange({...value, mentalState:n})} />
        <Scale label="Sleep quality"     value={value.sleepQuality}    lo="poor"  hi="rested"  onChange={(n)=>onChange({...value, sleepQuality:n})} />
        <Scale label="Stress level"      value={value.stressLevel}     lo="calm"  hi="tense"   onChange={(n)=>onChange({...value, stressLevel:n})} />
        <Scale label="Confidence level"  value={value.confidenceLevel} lo="low"   hi="grounded"onChange={(n)=>onChange({...value, confidenceLevel:n})} />
      </div>
      <div className="space-y-1.5 pt-1">
        <label className="flex items-center gap-2 text-xs text-slate-200">
          <input type="checkbox" checked={value.strategyReady}
            onChange={(e)=>onChange({...value, strategyReady: e.target.checked})}
            className="size-3.5 accent-sky-500" />
          I have selected today's strategy and reviewed it
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-200">
          <input type="checkbox" checked={value.riskRulesConfirmed}
            onChange={(e)=>onChange({...value, riskRulesConfirmed: e.target.checked})}
            className="size-3.5 accent-sky-500" />
          I have re-read my active rule contract and accept its limits
        </label>
      </div>
    </div>
  );
}
