import type { ChangeEvent } from "react";

export interface SelfReport {
  mentalState: number | null; sleepQuality: number | null;
  stressLevel: number | null; confidenceLevel: number | null;
  strategyReady: boolean; riskRulesConfirmed: boolean;
}
interface Props { value: SelfReport; onChange: (v: SelfReport) => void }

function Scale({ label, value, onChange, lo, hi }:
  { label: string; value: number | null; onChange: (n: number) => void; lo: string; hi: string }) {
  return (
    <label className="block space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-txt-secondary">{label}</span>
        <span className="font-mono text-txt-muted">{value ?? "—"}/5</span>
      </div>
      <input type="range" min={1} max={5} step={1} value={value ?? 3}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500" />
      <div className="flex justify-between text-[10px] text-txt-muted"><span>{lo}</span><span>{hi}</span></div>
    </label>
  );
}

export function MentalStateCheckIn({ value, onChange }: Props) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Mental check-in</h3>
      <p className="text-[11px] text-txt-secondary">Honest self-assessment. No score is "wrong" — this just shapes today's plan.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Scale label="Mental state"      value={value.mentalState}     lo="off"   hi="sharp"   onChange={(n)=>onChange({...value, mentalState:n})} />
        <Scale label="Sleep quality"     value={value.sleepQuality}    lo="poor"  hi="rested"  onChange={(n)=>onChange({...value, sleepQuality:n})} />
        <Scale label="Stress level"      value={value.stressLevel}     lo="calm"  hi="tense"   onChange={(n)=>onChange({...value, stressLevel:n})} />
        <Scale label="Confidence level"  value={value.confidenceLevel} lo="low"   hi="grounded"onChange={(n)=>onChange({...value, confidenceLevel:n})} />
      </div>
      <div className="space-y-1.5 pt-1">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input type="checkbox" checked={value.strategyReady}
            onChange={(e)=>onChange({...value, strategyReady: e.target.checked})}
            className="size-3.5 accent-sky-500" />
          I have selected today's strategy and reviewed it
        </label>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input type="checkbox" checked={value.riskRulesConfirmed}
            onChange={(e)=>onChange({...value, riskRulesConfirmed: e.target.checked})}
            className="size-3.5 accent-sky-500" />
          I have re-read my active rule contract and accept its limits
        </label>
      </div>
    </div>
  );
}
