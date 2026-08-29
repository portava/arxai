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
  const [report, setReport] = useState<SelfReport>({
    mentalState: 4, sleepQuality: 4, stressLevel: 2, confidenceLevel: 4,
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
      if (!r.ok) throw new Error("eval failed");
      return r.json();
    },
    refetchInterval: 15_000,
  });
  const evald = evalQ.data?.evaluation ?? null;

  const latest = useQuery<{ check: Check }>({
    queryKey: ["readiness-latest"],
    queryFn: async () => {
      const r = await fetch("/api/readiness/checks/latest");
      if (r.status === 404) throw new Error("none");
      return r.json();
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
        <h1 className="text-xl font-semibold text-foreground">Trading readiness</h1>
        <p className="text-xs text-txt-secondary">
          Pre-session check across broker, market, news, rules, mindset, and weekly goals.
          Advisory — execution authority remains with the safety layer.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <label className="block space-y-1 text-xs">
              <span className="text-txt-secondary">Session label</span>
              <input value={sessionName} onChange={(e)=>setSessionName(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
            </label>
          </div>
          <MentalStateCheckIn value={report} onChange={setReport} />
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
              {submit.isError && <p className="text-[11px] text-danger">{(submit.error as Error).message}</p>}
            </div>
          )}
          {latest.data && (
            <div className="rounded-lg border border-border bg-background/40 p-3 text-[11px]">
              <div className="mb-1 text-txt-secondary">Last submitted check</div>
              <div className="font-mono text-txt-secondary">
                {latest.data.check.status} · {latest.data.check.readinessScore}/100 ·
                {" "}{safeDate(latest.data.check.createdAt)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
