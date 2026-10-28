import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { safeDate } from "@/lib/safeFormat";
import {
  PreSessionChecklist, ReadinessScoreCard, MentalStateCheckIn,
  AiReadinessSummary, StartTradingButton,
  type SelfReport,
} from "@/components/readiness";

type Status = "READY"|"CAUTION"|"NOT_READY"|"LOCKED";
interface ChecklistItem { id: string; label: string; status: "PASS"|"WARN"|"FAIL"|"INFO"; detail: string }
interface Evaluation {
  status: Status; score: number;
  checklist: ChecklistItem[];
  reasons: string[]; warnings: string[]; blockers: string[];
  marketCondition: string; brokerStatus: string; newsRiskLevel: string;
  aiSummary: string;
}
interface Check {
  id: number; sessionName: string; readinessScore: number; status: Status;
  aiSummary: string; checklist: ChecklistItem[];
  blockers: string[]; warnings: string[];
  marketCondition: string; brokerStatus: string; newsRiskLevel: string;
  createdAt: string;
}

export default function TradingReadinessPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  // The self-report starts unanswered. Pre-filled values would be sent (and
  // stored on "Start trading session") as the trader's own answers and earn
  // the mental check a PASS that nobody gave.
  const [report, setReport] = useState<SelfReport>({
    mentalState: null, sleepQuality: null, stressLevel: null, confidenceLevel: null,
    strategyReady: false, riskRulesConfirmed: false,
  });
  const [sessionName, setSessionName] = useState("PRE_SESSION");

  const evalQ = useQuery<{ evaluation: Evaluation }>({
    queryKey: ["readiness-eval", report, sessionName],
    queryFn: async () => {
      const r = await fetch("/api/readiness/evaluate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, sessionName }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { evaluation?: Evaluation } | null;
      if (!body?.evaluation || !Array.isArray(body.evaluation.checklist)) throw new Error("unexpected response");
      return { evaluation: body.evaluation };
    },
    refetchInterval: 15_000,
  });
  // A failed request (including one still being retried) means the current
  // readiness is unknown: the last good result is not shown as current.
  const evalFailed = evalQ.isError || evalQ.failureCount > 0;
  const evald = evalFailed ? null : (evalQ.data?.evaluation ?? null);
  const evaluatedAt = evalQ.dataUpdatedAt > 0 ? new Date(evalQ.dataUpdatedAt) : null;

  // 404 is the server's "no check on record"; any other non-OK reply (not
  // signed in, server error) or an unexpected body is a failed read, shown as
  // "could not be loaded" rather than read as a check.
  const latest = useQuery<{ check: Check | null }>({
    queryKey: ["readiness-latest"],
    queryFn: async () => {
      const r = await fetch("/api/readiness/checks/latest");
      if (r.status === 404) return { check: null };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { check?: unknown } | null;
      if (!body || typeof body.check !== "object" || body.check === null) throw new Error("unexpected response");
      return { check: body.check as Check };
    },
    retry: false,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/readiness/checks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...report, sessionName }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: (d: { check: Check; evaluation: Evaluation }) => {
      qc.invalidateQueries({ queryKey: ["readiness-latest"] });
      if (d.evaluation.status === "READY" || d.evaluation.status === "CAUTION") {
        // Soft hand-off — go to dashboard.
        setLocation("/");
      }
    },
  });

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-100">Trading readiness</h1>
        <p className="text-xs text-slate-400">
          Pre-session check across broker, market, news, rules, mindset, and weekly goals.
          Advisory — execution authority remains with the safety layer.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <label className="block space-y-1 text-xs">
              <span className="text-slate-400">Session label</span>
              <input value={sessionName} onChange={(e)=>setSessionName(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
            </label>
          </div>
          <MentalStateCheckIn value={report} onChange={setReport} />
          {evalFailed && (
            <div role="alert" data-testid="readiness-eval-error"
              className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-xs text-red-200">
              Readiness could not be loaded
              {evalQ.failureReason ? ` (${(evalQ.failureReason as Error).message})` : ""}
              {evalQ.isError ? "." : " — retrying."}{" "}
              {evalQ.data && evaluatedAt
                ? `The last successful evaluation (${evaluatedAt.toLocaleTimeString()}) is not shown because it may no longer be current.`
                : "No readiness evaluation has been received yet."}
            </div>
          )}
          {!evalFailed && evalQ.isPending && (
            <p className="text-xs text-slate-500">Evaluating readiness…</p>
          )}
          {evald && evaluatedAt && (
            <p data-testid="readiness-evaluated-at" className="text-[11px] text-slate-500">
              Evaluated at {evaluatedAt.toLocaleTimeString()} from the server's current checks; refreshes every 15 s.
            </p>
          )}
          {evald && <PreSessionChecklist items={evald.checklist} />}
        </div>

        <div className="space-y-3">
          {evald && <ReadinessScoreCard score={evald.score} status={evald.status} />}
          {evald && <AiReadinessSummary status={evald.status} summary={evald.aiSummary}
            blockers={evald.blockers} warnings={evald.warnings} />}
          {evald && (
            <div className="space-y-2">
              <StartTradingButton status={evald.status}
                disabled={submit.isPending}
                onProceed={() => submit.mutate()} />
              {submit.isError && <p className="text-[11px] text-red-400">{(submit.error as Error).message}</p>}
            </div>
          )}
          <div data-testid="readiness-last-check"
            className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px]">
            <div className="mb-1 text-slate-400">Last submitted check</div>
            {latest.isError ? (
              <div className="text-red-300">
                Could not be loaded ({(latest.error as Error).message}).
              </div>
            ) : latest.isPending ? (
              <div className="text-slate-500">Loading…</div>
            ) : latest.data.check == null ? (
              <div className="text-slate-500">No readiness check has been submitted yet.</div>
            ) : (
              <div data-testid="readiness-last-check-summary" className="font-mono text-slate-300">
                {latest.data.check.status} · {latest.data.check.readinessScore}/100 ·
                {" "}{safeDate(latest.data.check.createdAt)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
