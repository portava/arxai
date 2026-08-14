/**
 * Trading School — Risk Simulator. A beginner risk calculator: enter account
 * size, risk %, stop and target distance; see dollar risk/reward, R:R, an
 * approximate position size, a too-high-risk warning, and Ruby's plain note.
 * Pure education math (lib/progress calcRiskSim) — NOT connected to live
 * execution. Renders inside AppLayout.
 */
import { useMemo, useState, type ChangeEvent } from "react";
import { RubyAvatar } from "@/components/ruby/RubyAvatar";
import { calcRiskSim } from "../lib/progress";
import { SchoolPageHeader, SchoolDisclaimer } from "../components/SchoolUI";
import { Calculator, AlertTriangle } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

function Field({ label, value, onChange, suffix }: { label: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-txt-secondary">{label}</span>
      <div className="mt-1 flex items-center rounded-lg border border-border bg-background/40 focus-within:border-primary/40">
        <input type="number" inputMode="decimal" value={Number.isFinite(value) ? value : 0}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
          className="w-full bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none" />
        {suffix && <span className="px-3 text-xs text-txt-muted">{suffix}</span>}
      </div>
    </label>
  );
}

export default function TradingSchoolRiskSimulator() {
  const { name } = useAssistantName();
  const [accountSize, setAccountSize] = useState(100);
  const [riskPct, setRiskPct] = useState(2);
  const [stopDistance, setStopDistance] = useState(20);
  const [targetDistance, setTargetDistance] = useState(60);
  const [valuePerUnit, setValuePerUnit] = useState(1);

  const r = useMemo(
    () => calcRiskSim({ accountSize, riskPct, stopDistance, targetDistance, valuePerUnit }),
    [accountSize, riskPct, stopDistance, targetDistance, valuePerUnit],
  );

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-school-risk-sim">
      <SchoolPageHeader title="Risk Simulator" subtitle="Practice the most important math in trading — before any real money is involved." icon={Calculator} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">Your plan</div>
          <Field label="Account size" value={accountSize} onChange={setAccountSize} suffix="$" />
          <Field label="Risk per trade" value={riskPct} onChange={setRiskPct} suffix="%" />
          <Field label="Stop distance" value={stopDistance} onChange={setStopDistance} suffix="pts" />
          <Field label="Target distance" value={targetDistance} onChange={setTargetDistance} suffix="pts" />
          <Field label="Value per point per lot" value={valuePerUnit} onChange={setValuePerUnit} suffix="$" />
          <p className="text-[11px] text-txt-muted">“Value per point” depends on the market and lot size. Default 1 keeps the math simple for learning.</p>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Dollar risk</div>
              <div className="text-lg font-bold text-danger">${r.dollarRisk.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Dollar reward</div>
              <div className="text-lg font-bold text-success">${r.dollarReward.toFixed(2)}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Risk : Reward</div>
              <div className="text-lg font-bold text-foreground">1 : {(r.riskReward).toFixed(1)}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Approx. position size</div>
              <div className="text-lg font-bold text-foreground">{r.positionSize.toFixed(2)}</div>
            </div>
          </div>

          {r.tooHighRisk && (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">Risk above 5% per trade is high for a beginner. Consider lowering it.</p>
            </div>
          )}

          <div className="rounded-2xl border border-ruby/25 bg-card p-4">
            <div className="mb-2 flex items-center gap-2.5">
              <RubyAvatar state={r.tooHighRisk ? "riskWarning" : "analyzingMarket"} size="md" ariaHidden />
              <div className="text-sm font-semibold text-foreground">{name}'s read</div>
            </div>
            <p className="text-sm text-txt-secondary">{r.rubyNote}</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-background/40 p-4">
        <SchoolDisclaimer text="This simulator is for education only. It does not place trades and does not predict outcomes. Real position sizing depends on the specific market, contract size, and your broker. Trading involves risk." />
      </div>
    </div>
  );
}
