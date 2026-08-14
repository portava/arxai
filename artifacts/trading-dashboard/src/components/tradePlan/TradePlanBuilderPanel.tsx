import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { TradePlanChecklist } from "./TradePlanChecklist";
import { AIPlanReviewCard } from "./AIPlanReviewCard";
import { RiskPreviewCard } from "./RiskPreviewCard";
import { StrategyFitPreview } from "./StrategyFitPreview";
import { ConvertToLiveExecutionButton } from "./ConvertToLiveExecutionButton";
import { MultiTimeframeAlignmentCard } from "../multiTimeframe";
import { NewsRiskCard } from "../news";

type Status = "DRAFT" | "READY" | "INVALIDATED" | "EXECUTED" | "CANCELED";

interface TradePlan {
  id: number;
  symbol: string | null;
  directionBias: string | null;
  strategyId: string | null;
  marketCondition: string | null;
  entryConditions: string | null;
  invalidationConditions: string | null;
  stopLossPlan: string | null;
  takeProfitPlan: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lotSize: number | null;
  riskAmount: number | null;
  maxLossAllowed: number | null;
  rewardToRiskTarget: number | null;
  confidenceLevel: number | null;
  status: Status;
  aiSummary: string | null;
  checklist: {
    items: { key: string; label: string; status: "PASS" | "FAIL" | "WARN" | "UNKNOWN"; detail: string }[];
    passCount: number; failCount: number; warnCount: number; isReady: boolean; rewardToRisk?: number | null;
  } | null;
  executionConfirmationId: number | null;
}

const STATUS_COLORS: Record<Status, string> = {
  DRAFT: "bg-slate-700 text-slate-200",
  READY: "bg-green-600 text-white",
  INVALIDATED: "bg-amber-600 text-white",
  EXECUTED: "bg-indigo-600 text-white",
  CANCELED: "bg-slate-800 text-slate-400",
};

function asNum(v: string): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function TradePlanBuilderPanel() {
  const qc = useQueryClient();

  const list = useQuery<{ plans: TradePlan[] }>({
    queryKey: ["trade-plans"],
    queryFn: async () => {
      const r = await fetch("/api/trade-plans?limit=20");
      if (!r.ok) throw new Error("Failed to load trade plans");
      return r.json();
    },
  });

  const [activeId, setActiveId] = useState<number | null>(null);
  useEffect(() => {
    if (activeId == null && list.data?.plans?.[0]) setActiveId(list.data.plans[0].id);
  }, [list.data, activeId]);
  const active = useMemo(() => list.data?.plans.find((p) => p.id === activeId) ?? null, [list.data, activeId]);

  const [form, setForm] = useState<Partial<TradePlan>>({});
  useEffect(() => { setForm(active ?? {}); }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/trade-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      if (!r.ok) throw new Error("create failed");
      return r.json() as Promise<TradePlan>;
    },
    onSuccess: (p) => { setActiveId(p.id); qc.invalidateQueries({ queryKey: ["trade-plans"] }); },
  });

  const save = useMutation({
    mutationFn: async (input: Partial<TradePlan>) => {
      if (!active) return;
      const body: Record<string, unknown> = {};
      const keys: (keyof TradePlan)[] = [
        "symbol","directionBias","strategyId","marketCondition","entryConditions","invalidationConditions",
        "stopLossPlan","takeProfitPlan","entryPrice","stopLoss","takeProfit","lotSize","riskAmount",
        "maxLossAllowed","rewardToRiskTarget","confidenceLevel",
      ];
      for (const k of keys) if (input[k] !== undefined) body[k] = input[k];
      const r = await fetch(`/api/trade-plans/${active.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("save failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  const validate = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const r = await fetch(`/api/trade-plans/${active.id}/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error("validate failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const r = await fetch(`/api/trade-plans/${active.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error("cancel failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  const editable = active && active.status !== "EXECUTED" && active.status !== "CANCELED";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      {/* sidebar */}
      <aside className="space-y-2">
        <button
          onClick={() => create.mutate()}
          className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          disabled={create.isPending}
        >
          {create.isPending ? "Creating…" : "+ New trade plan"}
        </button>
        <div className="space-y-1">
          {(list.data?.plans ?? []).map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                p.id === activeId ? "border-indigo-500 bg-slate-800" : "border-slate-700 bg-slate-900 hover:bg-slate-800"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-100">{p.symbol ?? "Untitled"}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[p.status]}`}>{p.status}</span>
              </div>
              <div className="text-xs text-slate-400">
                {p.directionBias ?? "—"} · {p.strategyId ?? "no strategy"}
              </div>
            </button>
          ))}
          {!list.data?.plans?.length && <p className="text-xs text-slate-500">No plans yet.</p>}
        </div>
      </aside>

      {/* editor */}
      {!active ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-6 text-sm text-slate-400">
          Create a new trade plan to begin.
        </div>
      ) : (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Plan #{active.id}</h2>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[active.status]}`}>{active.status}</span>
          </div>

          {/* form */}
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4 sm:grid-cols-2">
            <Field label="Symbol">
              <input value={form.symbol ?? ""} onChange={(e) => setForm({ ...form, symbol: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Direction bias">
              <select value={form.directionBias ?? ""} onChange={(e) => setForm({ ...form, directionBias: e.target.value || null })} className={inputCls} disabled={!editable}>
                <option value="">—</option><option>BUY</option><option>SELL</option><option>NEUTRAL</option>
              </select>
            </Field>
            <Field label="Strategy">
              <input value={form.strategyId ?? ""} onChange={(e) => setForm({ ...form, strategyId: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Market condition">
              <select value={form.marketCondition ?? ""} onChange={(e) => setForm({ ...form, marketCondition: e.target.value || null })} className={inputCls} disabled={!editable}>
                <option value="">—</option><option>TRENDING</option><option>RANGING</option><option>NO_TRADE</option><option>UNKNOWN</option>
              </select>
            </Field>
            <Field label="Entry price">
              <input type="number" step="any" value={form.entryPrice ?? ""} onChange={(e) => setForm({ ...form, entryPrice: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Stop loss">
              <input type="number" step="any" value={form.stopLoss ?? ""} onChange={(e) => setForm({ ...form, stopLoss: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Take profit">
              <input type="number" step="any" value={form.takeProfit ?? ""} onChange={(e) => setForm({ ...form, takeProfit: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Lot size">
              <input type="number" step="any" value={form.lotSize ?? ""} onChange={(e) => setForm({ ...form, lotSize: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Risk amount ($)">
              <input type="number" step="any" value={form.riskAmount ?? ""} onChange={(e) => setForm({ ...form, riskAmount: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Max loss allowed ($)">
              <input type="number" step="any" value={form.maxLossAllowed ?? ""} onChange={(e) => setForm({ ...form, maxLossAllowed: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="R:R target">
              <input type="number" step="any" value={form.rewardToRiskTarget ?? ""} onChange={(e) => setForm({ ...form, rewardToRiskTarget: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Confidence (0-100)">
              <input type="number" min={0} max={100} value={form.confidenceLevel ?? ""} onChange={(e) => setForm({ ...form, confidenceLevel: asNum(e.target.value) })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Entry conditions" full>
              <textarea rows={2} value={form.entryConditions ?? ""} onChange={(e) => setForm({ ...form, entryConditions: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Invalidation conditions" full>
              <textarea rows={2} value={form.invalidationConditions ?? ""} onChange={(e) => setForm({ ...form, invalidationConditions: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Stop loss plan" full>
              <textarea rows={2} value={form.stopLossPlan ?? ""} onChange={(e) => setForm({ ...form, stopLossPlan: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <Field label="Take profit plan" full>
              <textarea rows={2} value={form.takeProfitPlan ?? ""} onChange={(e) => setForm({ ...form, takeProfitPlan: e.target.value })} className={inputCls} disabled={!editable}/>
            </Field>
            <div className="sm:col-span-2 flex flex-wrap gap-2 pt-2">
              <button onClick={() => save.mutate(form)} disabled={!editable || save.isPending} className="rounded-md bg-slate-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              <button onClick={() => validate.mutate()} disabled={!editable || validate.isPending} className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {validate.isPending ? "Validating…" : "Validate plan"}
              </button>
              <button onClick={() => cancel.mutate()} disabled={!editable || cancel.isPending} className="rounded-md border border-red-700 bg-red-950 px-3 py-2 text-sm font-semibold text-red-200 disabled:opacity-50">
                Cancel plan
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <RiskPreviewCard plan={active} />
            <StrategyFitPreview plan={active} />
            <AIPlanReviewCard summary={active.aiSummary} />
          </div>

          {/* (M) Multi-timeframe alignment — non-blocking advisory. */}
          <MultiTimeframeAlignmentCard symbol={active.symbol} />

          {/* (N) News & economic-event risk — blocks validate when NO_TRADE_WINDOW. */}
          <NewsRiskCard symbol={active.symbol} />

          <TradePlanChecklist checklist={active.checklist} />

          {active.executionConfirmationId == null
            ? <ConvertToLiveExecutionButton planId={active.id} isReady={active.status === "READY"} />
            : <div className="rounded-md border border-indigo-700 bg-indigo-950/40 p-3 text-sm text-indigo-200">
                Converted to execution confirmation #{active.executionConfirmationId}. Open the Pre-Trade Confirmation flow to review and confirm.
              </div>
          }
        </section>
      )}
    </div>
  );
}

const inputCls = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-60";

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label className={`block text-xs ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-slate-400">{label}</span>
      {children}
    </label>
  );
}
