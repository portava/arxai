/**
 * TradePlanLab — a guided practice trade-plan form that produces a
 * deterministic 0–100 CHECKLIST score (pure scoreTradePlan rubric), computed
 * in the browser from fixed rules. No AI and no API call is involved, and the
 * copy says so. Links to the real Trade Plan Builder for actual planning.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { EMPTY_TRADE_PLAN, scoreTradePlan, type TradePlanInput } from "../../lib/labMath";
import { CheckCircle2, XCircle, RotateCcw, ClipboardCheck, ArrowRight, MinusCircle } from "lucide-react";

const MARKETS = ["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD (gold)", "US500 (index)", "BTC/USD"];

const EXAMPLE: TradePlanInput = {
  market: "EUR/USD",
  direction: "long",
  reason: "Uptrend on the 1-hour chart; price pulled back to the old resistance at 1.0960, which is now acting as support, and printed a rejection wick.",
  entry: "1.0985",
  stop: "1.0950",
  target: "1.1060",
  riskPct: "1",
  invalidation: "A 1-hour close below 1.0950 (the swing low) means the pullback failed.",
  sessionChecked: true,
  newsChecked: true,
};

function TextField({ label, value, onChange, placeholder, testId, multiline, inputMode }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; testId: string; multiline?: boolean; inputMode?: "decimal";
}) {
  const cls = "mt-1 w-full min-w-0 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground placeholder:text-txt-muted focus:border-primary/40 focus:outline-none";
  return (
    <label className="block min-w-0">
      <span className="text-xs font-medium text-txt-secondary">{label}</span>
      {multiline
        ? <textarea rows={2} value={value} placeholder={placeholder} data-testid={testId} onChange={(e) => onChange(e.target.value)} className={cls} />
        : <input type={inputMode ? "number" : "text"} inputMode={inputMode} step="any" value={value} placeholder={placeholder} data-testid={testId} onChange={(e) => onChange(e.target.value)} className={cls} />}
    </label>
  );
}

export function TradePlanLab({ onScored }: { onScored?: (score: number) => void }) {
  const [plan, setPlan] = useState<TradePlanInput>({ ...EMPTY_TRADE_PLAN });
  const [shown, setShown] = useState(false);
  const result = useMemo(() => scoreTradePlan(plan), [plan]);
  const set = <K extends keyof TradePlanInput>(k: K, v: TradePlanInput[K]) => setPlan((p) => ({ ...p, [k]: v }));

  const score = () => { setShown(true); onScored?.(result.score); };
  const tone = result.score >= 80 ? "success" : result.score >= 50 ? "warning" : "danger";

  return (
    <div className="space-y-3" data-testid="lab-trade-plan-body">
      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">Your practice plan</div>
          <button onClick={() => { setPlan({ ...EXAMPLE }); setShown(false); }} className="text-xs font-medium text-primary hover:underline">
            Load an example plan
          </button>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-txt-secondary">Market</span>
          <select value={plan.market} data-testid="plan-market" onChange={(e) => set("market", e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground focus:border-primary/40 focus:outline-none">
            <option value="">Choose a market…</option>
            {MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <div>
          <span className="text-xs font-medium text-txt-secondary">Direction</span>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(["long", "short"] as const).map((d) => (
              <button key={d} type="button" onClick={() => set("direction", d)} data-testid={`plan-direction-${d}`}
                className={cn("rounded-lg border px-3 py-2 text-sm font-medium",
                  plan.direction === d
                    ? d === "long" ? "border-success/50 bg-success/10 text-success" : "border-danger/50 bg-danger/10 text-danger"
                    : "border-border bg-background/40 text-txt-secondary hover:border-primary/30")}>
                {d === "long" ? "Buy (long)" : "Sell (short)"}
              </button>
            ))}
          </div>
        </div>

        <TextField label="Reason for the trade" value={plan.reason} onChange={(v) => set("reason", v)} multiline testId="plan-reason"
          placeholder="What do you see? Trend, level, trigger…" />

        <div className="grid grid-cols-3 gap-2">
          <TextField label="Entry" value={plan.entry} onChange={(v) => set("entry", v)} inputMode="decimal" testId="plan-entry" />
          <TextField label="Stop-loss" value={plan.stop} onChange={(v) => set("stop", v)} inputMode="decimal" testId="plan-stop" />
          <TextField label="Take-profit" value={plan.target} onChange={(v) => set("target", v)} inputMode="decimal" testId="plan-target" />
        </div>

        <TextField label="Risk per trade (% of account)" value={plan.riskPct} onChange={(v) => set("riskPct", v)} inputMode="decimal" testId="plan-risk" placeholder="e.g. 1" />
        <TextField label="Invalidation — what proves this idea wrong?" value={plan.invalidation} onChange={(v) => set("invalidation", v)} multiline testId="plan-invalidation"
          placeholder="e.g. a close below the swing low" />

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-txt-secondary">
            <input type="checkbox" checked={plan.sessionChecked} data-testid="plan-session" onChange={(e) => set("sessionChecked", e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
            I checked the market is in an active session
          </label>
          <label className="flex items-center gap-2 text-sm text-txt-secondary">
            <input type="checkbox" checked={plan.newsChecked} data-testid="plan-news" onChange={(e) => set("newsChecked", e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
            I checked the news calendar for high-impact events
          </label>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={score} data-testid="plan-score-btn" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90">
            <ClipboardCheck className="h-4 w-4" /> Get checklist score
          </button>
          <button onClick={() => { setPlan({ ...EMPTY_TRADE_PLAN }); setShown(false); }} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/40">
            <RotateCcw className="h-4 w-4" /> Start over
          </button>
        </div>
      </div>

      {shown && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3" data-testid="plan-result">
          <div className="flex items-center gap-3">
            <div className={cn("grid h-16 w-16 shrink-0 place-items-center rounded-2xl border text-2xl font-bold",
              tone === "success" ? "border-success/40 bg-success/10 text-success" : tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-danger/40 bg-danger/10 text-danger")}
              data-testid="plan-score">
              {result.score}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">Checklist score: {result.score} / 100</div>
              <p className="text-xs text-txt-muted">
                Calculated on this page from fixed checklist rules — it checks that your plan is complete and consistent. It is not a review of the idea and says nothing about whether the trade would win.
              </p>
            </div>
          </div>
          <ul className="space-y-1.5">
            {result.items.map((it) => (
              <li key={it.id} className="flex items-start gap-2 text-xs" data-testid={`rubric-${it.id}`}>
                {it.points === it.max
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  : it.points > 0 ? <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                <span className="min-w-0 flex-1 text-txt-secondary"><span className="font-semibold text-foreground">{it.label}</span> — {it.feedback}</span>
                <span className="shrink-0 font-mono text-txt-muted">{it.points}/{it.max}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link href="/trade-plan-builder" className="flex items-center justify-between gap-2 rounded-2xl border border-primary/30 bg-card p-4 hover:border-primary/50">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Ready for a real plan?</div>
          <p className="text-xs text-txt-muted">Open the Trade Plan Builder to write a plan for an actual market.</p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
      </Link>
    </div>
  );
}
