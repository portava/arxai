import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { TradePlanChecklist } from "./TradePlanChecklist";
import { AIPlanReviewCard } from "./AIPlanReviewCard";
import { RiskPreviewCard } from "./RiskPreviewCard";
import { StrategyFitPreview, type PlanChartCheck } from "./StrategyFitPreview";
import { ConvertToLiveExecutionButton, SentToConfirmationStatus } from "./ConvertToLiveExecutionButton";
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
    checkedAtIso?: string | null;
  } | null;
  /** The plan was saved after its checklist / AI review were computed. */
  checklistStale?: boolean;
  executionConfirmationId: number | null;
}

const STATUS_COLORS: Record<Status, string> = {
  DRAFT: "bg-slate-700 text-slate-200",
  READY: "bg-green-600 text-white",
  INVALIDATED: "bg-amber-600 text-white",
  EXECUTED: "bg-indigo-900 text-indigo-100",
  CANCELED: "bg-slate-800 text-slate-400",
};

// What a failed request reports: the HTTP status, or the browser's network
// error. Shown verbatim so the user knows the request failed rather than
// seeing an empty or unchanged screen.
function failureDetail(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "unknown error";
}

// The server's EXECUTED means "sent to the Pre-Trade Confirmation flow": convert
// creates a practice confirmation request and places no order. The badge says
// what happened, never "EXECUTED".
const STATUS_LABEL: Record<Status, string> = {
  DRAFT: "DRAFT",
  READY: "READY",
  INVALIDATED: "INVALIDATED",
  EXECUTED: "SENT TO CONFIRMATION",
  CANCELED: "CANCELED",
};

/** A validate the server refused (409) or could not complete. */
class ValidateError extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) {
    super(message);
    this.refused = refused;
  }
}

const REFUSAL_TITLE: Record<string, string> = {
  NEWS_NO_TRADE_WINDOW: "a news no-trade window",
  PORTFOLIO_RISK_CRITICAL: "critical portfolio risk",
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

  // The latest validate attempt that did not produce a result, per plan. A
  // refusal (409) leaves the stored status as it was, so an earlier READY is
  // still on the row: it is labelled as from an earlier check and cannot be
  // sent from here until a validate passes again.
  const [validateFailure, setValidateFailure] = useState<{ planId: number; refused: boolean; message: string } | null>(null);
  // What the latest successful validate said about Chart Truth, per plan. GET
  // does not carry it (it is a reading of the chart at that moment), so it is
  // kept from the validate response and dropped when the plan is saved again.
  const [chartCheck, setChartCheck] = useState<(PlanChartCheck & { planId: number }) | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/trade-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      if (active && chartCheck?.planId === active.id) setChartCheck(null);
      qc.invalidateQueries({ queryKey: ["trade-plans"] });
    },
  });

  const validate = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const r = await fetch(`/api/trade-plans/${active.id}/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
        if (r.status === 409) {
          const what = err.error ? REFUSAL_TITLE[err.error] : undefined;
          const reason = err.reason ?? err.error ?? `HTTP ${r.status}`;
          throw new ValidateError(what ? `Refused because of ${what}: ${reason}` : `Refused: ${reason}`, true);
        }
        throw new ValidateError(`Validation could not be completed (${err.error ?? `HTTP ${r.status}`}). Nothing was checked.`, false);
      }
      return r.json();
    },
    onMutate: () => { setValidateFailure(null); setChartCheck(null); },
    onSuccess: (data: {
      id?: number;
      chartTruthStatus?: PlanChartCheck["status"];
      chartTruthScore?: number | null;
      chartQualityNote?: string | null;
      effectiveConfidenceLevel?: number | null;
    } | undefined) => {
      if (data && typeof data.id === "number") {
        setChartCheck({
          planId: data.id,
          status: data.chartTruthStatus ?? null,
          chartTruthScore: data.chartTruthScore ?? null,
          chartQualityNote: data.chartQualityNote ?? null,
          effectiveConfidenceLevel: data.effectiveConfidenceLevel ?? null,
          checkedAtIso: new Date().toISOString(),
        });
      }
      qc.invalidateQueries({ queryKey: ["trade-plans"] });
    },
    onError: (e: Error) => {
      if (active) setValidateFailure({ planId: active.id, refused: e instanceof ValidateError && e.refused, message: e.message });
    },
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const r = await fetch(`/api/trade-plans/${active.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  // A failed save / validate / cancel belongs to the plan it was tried on;
  // clear it when the user switches plans so it is not shown against another.
  useEffect(() => {
    save.reset();
    validate.reset();
    cancel.reset();
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = active && active.status !== "EXECUTED" && active.status !== "CANCELED";
  const activeValidateFailure = active && validateFailure?.planId === active.id ? validateFailure : null;
  // A DRAFT carrying a checklist was saved after it was validated; the server
  // flags it, and plans edited before that flag existed read the same way.
  const checklistStale = active != null && (active.checklistStale === true || (active.status === "DRAFT" && active.checklist != null));

  // "No plans yet" is only true once the list has actually loaded empty. A
  // failed or still-pending request says nothing about whether plans exist.
  const listLoaded = list.status === "success";
  const listFailed = list.isError;
  const hasStaleList = listFailed && (list.data?.plans?.length ?? 0) > 0;

  // A failed validate is shown by the validation box below (refused vs not
  // completed, and whether an earlier READY still holds), not here.
  const actionError = save.isError
    ? `Your changes were not saved (${failureDetail(save.error)}).`
    : cancel.isError
      ? `The plan was not cancelled (${failureDetail(cancel.error)}).`
      : null;

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
        {create.isError && (
          <p data-testid="trade-plan-create-error" role="alert" className="text-xs text-red-300">
            A new plan was not created ({failureDetail(create.error)}).
          </p>
        )}
        {listFailed && (
          <div data-testid="trade-plans-load-error" role="alert" className="rounded-md border border-red-800 bg-red-950/40 p-2 text-xs text-red-200">
            {hasStaleList
              ? `Your trade plans could not be loaded just now (${failureDetail(list.error)}). The list below is from the last successful load and may be out of date.`
              : `Your trade plans could not be loaded (${failureDetail(list.error)}). This is not an empty list — saved plans are not shown because the request failed.`}
            <button
              type="button"
              onClick={() => list.refetch()}
              className="ml-1 underline"
            >
              Retry
            </button>
          </div>
        )}
        {list.isPending && <p className="text-xs text-slate-500">Loading your trade plans…</p>}
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
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[p.status]}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
              </div>
              <div className="text-xs text-slate-400">
                {p.directionBias ?? "—"} · {p.strategyId ?? "no strategy"}
              </div>
            </button>
          ))}
          {listLoaded && !list.data?.plans?.length && <p className="text-xs text-slate-500">No plans yet.</p>}
        </div>
      </aside>

      {/* editor */}
      {!active ? (
        listFailed ? (
          <div data-testid="trade-plan-editor-unavailable" className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-sm text-red-200">
            Your trade plans could not be loaded, so ARX cannot show whether you already have a plan for this trade. Retry loading before starting a new one.
          </div>
        ) : list.isPending ? (
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-6 text-sm text-slate-400">
            Loading your trade plans…
          </div>
        ) : (
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-6 text-sm text-slate-400">
            Create a new trade plan to begin.
          </div>
        )
      ) : (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Plan #{active.id}</h2>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[active.status]}`}>{STATUS_LABEL[active.status] ?? active.status}</span>
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
            {(actionError || activeValidateFailure) && (
              <div data-testid="trade-plan-action-error" role="alert" className="sm:col-span-2 space-y-2">
                {actionError && <p className="text-xs text-red-300">{actionError}</p>}
                {activeValidateFailure && (
                  <div className="rounded-md border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
                    <p>
                      {activeValidateFailure.refused ? "The latest validation refused this plan." : "The plan was not validated."}{" "}
                      {activeValidateFailure.message}
                    </p>
                    {active.status === "READY" ? (
                      <p className="mt-1 text-xs text-amber-300">
                        The plan&apos;s status was not changed: READY is from an earlier check and does not hold now.
                        It cannot be sent from here until a validation passes again.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-amber-300">Its status and checklist below are unchanged.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <RiskPreviewCard plan={active} />
            <StrategyFitPreview plan={active} chartCheck={chartCheck?.planId === active.id ? chartCheck : null} />
            <AIPlanReviewCard summary={active.aiSummary} stale={checklistStale} />
          </div>

          {/* (M) Multi-timeframe alignment — non-blocking advisory. */}
          <MultiTimeframeAlignmentCard symbol={active.symbol} />

          {/* (N) News & economic-event risk — blocks validate when NO_TRADE_WINDOW. */}
          <NewsRiskCard symbol={active.symbol} />

          <TradePlanChecklist checklist={active.checklist} planStatus={active.status} stale={checklistStale} />

          {active.executionConfirmationId == null
            ? <ConvertToLiveExecutionButton planId={active.id} isReady={active.status === "READY" && activeValidateFailure == null} />
            : <SentToConfirmationStatus confirmationId={active.executionConfirmationId} />
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
