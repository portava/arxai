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

/** A failed request that carries the HTTP status it was answered with. */
function httpFailure(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// A 4xx answer is the server refusing before it changes the plan (bad id, not
// found, wrong status, news / portfolio block). A 5xx or a lost response may
// come after the change was stored, so its outcome is unknown.
function refusedBeforeChange(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

// A READY plan whose latest validate in this session did not produce a result
// is never badged as a green READY. A refusal (4xx) does not change the stored
// status, so that READY is from the earlier check. A validate whose outcome is
// unknown (5xx / lost response) may have committed READY before it failed, so
// that READY may be from this request or the earlier check: it is unconfirmed.
const READY_EARLIER_LABEL = "READY (earlier check)";
const READY_UNCONFIRMED_LABEL = "READY (unconfirmed)";
const READY_EARLIER_COLOR = "bg-amber-700 text-amber-50";

function statusBadge(
  status: Status,
  validateFailure: { refused: boolean } | null | undefined,
): { label: string; color: string } {
  if (status === "READY" && validateFailure) {
    return { label: validateFailure.refused ? READY_EARLIER_LABEL : READY_UNCONFIRMED_LABEL, color: READY_EARLIER_COLOR };
  }
  return { label: STATUS_LABEL[status] ?? status, color: STATUS_COLORS[status] };
}

/**
 * A validate the server refused (4xx: before any change, e.g. a 409 news /
 * portfolio block) or whose outcome is unknown (5xx: validate may have
 * committed READY / INVALIDATED before it failed).
 */
class ValidateError extends Error {
  readonly refused: boolean;
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.refused = refusedBeforeChange({ status });
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
  // refusal (4xx) leaves the stored status as it was, so an earlier READY is
  // still on the row: it is labelled as from an earlier check. After a failure
  // whose outcome is unknown (5xx / lost response) a READY is labelled as
  // unconfirmed. Either way it cannot be sent from here until a validate
  // passes again. Validating one plan clears only that plan's entry. Nothing
  // is stored on the server, so a reload loses it.
  const [validateFailures, setValidateFailures] = useState<Record<number, { refused: boolean; message: string }>>({});
  // What the latest successful validate said about Chart Truth, per plan. GET
  // does not carry it (it is a reading of the chart at that moment), so it is
  // kept from the validate response and dropped when the plan is saved again.
  const [chartCheck, setChartCheck] = useState<(PlanChartCheck & { planId: number }) | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/trade-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      if (!r.ok) throw httpFailure(r.status);
      return r.json() as Promise<TradePlan>;
    },
    onSuccess: (p) => { setActiveId(p.id); },
    // The server stores the new plan before its vault write, which can still
    // fail (500), and a response can be lost after the insert: re-read the
    // list on failure too, so a plan that was created is listed.
    onSettled: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
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
      if (!r.ok) throw httpFailure(r.status);
      return r.json();
    },
    onSuccess: () => {
      if (active && chartCheck?.planId === active.id) setChartCheck(null);
    },
    // A save whose outcome is unknown may have stored new values, so the chart
    // check taken on the old ones no longer applies to what is shown.
    onError: (e: Error) => {
      if (!refusedBeforeChange(e) && active && chartCheck?.planId === active.id) setChartCheck(null);
    },
    // Re-read on failure too: a failed answer does not say what the server stored.
    onSettled: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  // The plan id is the mutation variable: the user can select another plan
  // while a validate is in flight, and React Query runs onError with the
  // latest render's closure, so `active` then is a different plan. The result
  // belongs to the plan that was validated.
  const validate = useMutation({
    mutationFn: async (planId: number) => {
      const r = await fetch(`/api/trade-plans/${planId}/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
        const http = `HTTP ${r.status}`;
        if (refusedBeforeChange({ status: r.status })) {
          const what = err.error ? REFUSAL_TITLE[err.error] : undefined;
          const reason = err.reason ?? err.error;
          const detail = reason ? `${http}: ${reason}` : http;
          throw new ValidateError(what ? `Refused because of ${what} (${detail}).` : `Refused (${detail}).`, r.status);
        }
        throw new ValidateError(`Validation could not be completed (${err.error ? `${http}: ${err.error}` : http}).`, r.status);
      }
      return r.json();
    },
    onMutate: (planId: number) => {
      setValidateFailures((m) => {
        if (!(planId in m)) return m;
        const next = { ...m };
        delete next[planId];
        return next;
      });
      setChartCheck(null);
    },
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
    },
    onError: (e: Error, planId: number) => {
      setValidateFailures((m) => ({
        ...m,
        [planId]: e instanceof ValidateError
          ? { refused: e.refused, message: e.message }
          : { refused: false, message: `The validate request failed (${failureDetail(e)}).` },
      }));
    },
    // Re-read on failure too: a failed answer does not say what the server stored.
    onSettled: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!active) return;
      const r = await fetch(`/api/trade-plans/${active.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) throw httpFailure(r.status);
      return r.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["trade-plans"] }),
  });

  // A failed save / validate / cancel belongs to the plan it was tried on;
  // clear it when the user switches plans so it is not shown against another.
  useEffect(() => {
    save.reset();
    validate.reset();
    cancel.reset();
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = active && active.status !== "EXECUTED" && active.status !== "CANCELED";
  const activeValidateFailure = active ? validateFailures[active.id] ?? null : null;
  // A DRAFT carrying a checklist was saved after it was validated; the server
  // flags it, and plans edited before that flag existed read the same way.
  const checklistStale = active != null && (active.checklistStale === true || (active.status === "DRAFT" && active.checklist != null));

  // "No plans yet" is only true once the list has actually loaded empty. A
  // failed or still-pending request says nothing about whether plans exist.
  const listLoaded = list.status === "success";
  const listFailed = list.isError;
  const hasStaleList = listFailed && (list.data?.plans?.length ?? 0) > 0;

  // Only a 4xx refusal says the plan was not changed. Any other failure says
  // the outcome could not be confirmed; the plans are re-read (onSettled), so
  // the status and checklist shown come from the server. A failed validate is
  // shown by the validation box below (refused vs unconfirmed, and whether a
  // READY on the row still holds), not here.
  const unconfirmed = "check the plan's status once your plans reload.";
  const actionError = save.isError
    ? refusedBeforeChange(save.error)
      ? `The server refused your changes (${failureDetail(save.error)}). They were not saved.`
      : `Saving failed (${failureDetail(save.error)}). ARX could not confirm whether your changes were saved; ${unconfirmed}`
    : cancel.isError
      ? refusedBeforeChange(cancel.error)
        ? `The server refused to cancel the plan (${failureDetail(cancel.error)}). It was not cancelled.`
        : `The cancel request failed (${failureDetail(cancel.error)}). ARX could not confirm whether the plan was cancelled; ${unconfirmed}`
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
            {refusedBeforeChange(create.error)
              ? `The server refused to create a plan (${failureDetail(create.error)}). No plan was created.`
              : `Creating the plan failed (${failureDetail(create.error)}). ARX could not confirm whether a plan was created; check your plans once they reload.`}
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
                {(() => {
                  const b = statusBadge(p.status, validateFailures[p.id]);
                  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.color}`} data-testid={`trade-plan-status-${p.id}`}>{b.label}</span>;
                })()}
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
            {(() => {
              const b = statusBadge(active.status, activeValidateFailure);
              return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${b.color}`} data-testid="trade-plan-status-active">{b.label}</span>;
            })()}
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
              <button onClick={() => validate.mutate(active.id)} disabled={!editable || validate.isPending} className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
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
                    {/* A 4xx refusal changed nothing. Any other failure may come
                        after validate committed READY / INVALIDATED, so neither
                        "not validated" nor "unchanged" can be said there. */}
                    <p>
                      {activeValidateFailure.refused
                        ? "The server refused to validate this plan; it was not validated."
                        : "ARX could not confirm whether the plan was validated."}{" "}
                      {activeValidateFailure.message}
                    </p>
                    {activeValidateFailure.refused ? (
                      active.status === "READY" ? (
                        <p className="mt-1 text-xs text-amber-300">
                          The plan&apos;s status was not changed: READY is from an earlier check and does not hold now.
                          It cannot be sent from here until a validation passes again.
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-amber-300">Its status and checklist below are unchanged.</p>
                      )
                    ) : (
                      <p className="mt-1 text-xs text-amber-300">
                        Check the plan&apos;s status and checklist once your plans reload.
                        {active.status === "READY"
                          ? " READY may be from this request or from an earlier check, and whether it holds now is not known, so it cannot be sent from here until a validation passes again."
                          : ""}
                      </p>
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

          <TradePlanChecklist
            checklist={active.checklist}
            planStatus={active.status}
            stale={checklistStale}
            latestValidateFailure={activeValidateFailure}
          />

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
