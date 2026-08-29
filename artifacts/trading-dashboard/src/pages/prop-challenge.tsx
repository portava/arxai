import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PropChallengeProgressCard, PropProfitTargetMeter, PropDrawdownMeter,
  PropDailyLossLimitCard, PropRuleViolationFeed, PropChallengeCalendar, PropPassFailBanner,
  PropExtendedRulesPanel,
} from "@/components/propChallenges";

interface Challenge {
  id: number; challengeName: string; paperAccountId: number;
  startingBalance: number; profitTarget: number; maxDailyLoss: number;
  maxTotalDrawdown: number; minTradingDays: number; maxTradingDays: number;
  consistencyRulePercent: number; status: string; failureReason: string | null;
  startedAt: string; completedAt: string | null;
  // Phase 27-B extended rules
  trailingDrawdownEnabled?: number; trailingDrawdownAmount?: number;
  trailingDrawdownType?: "STATIC" | "TRAILING";
  maxRiskPerTrade?: number; maxOpenTrades?: number; maxPendingOrders?: number;
  maxPositionSize?: number; newsTradingAllowed?: number;
  weekendHoldingAllowed?: number; overnightHoldingAllowed?: number;
  strictGuardrailsEnabled?: number;
}
interface EvalResp {
  summary: {
    status: string; failureReason: string | null;
    totalPnl: number; totalPct: number; peakBalance: number; maxDrawdownPct: number;
    worstDayPct: number; worstDayDate: string | null; bestDayPnl: number;
    daysWorked: number; daysSinceStart: number; consistencyTopShare: number;
    tradeCount: number; profitTarget: number; maxDailyLoss: number;
    maxTotalDrawdown: number; minTradingDays: number; maxTradingDays: number;
    currentBalance: number;
  };
  days: Array<{ tradeDate: string; dailyProfitLoss: number; tradesTaken: number; dailyLossPercent: number }>;
  violations: Array<{ type: string; severity: "INFO"|"WARN"|"HARD"; message: string }>;
}

export default function PropChallengePage() {
  const qc = useQueryClient();
  const [paperAccountId, setPaperAccountId] = useState(1);
  const [name, setName] = useState("Practice Challenge");

  const list = useQuery<{ challenges: Challenge[] }>({
    queryKey: ["prop-list"],
    queryFn: async () => (await fetch("/api/prop-challenges")).json(),
    refetchInterval: 8000,
  });
  const active = list.data?.challenges.find((c) => c.status === "ACTIVE" || c.status === "PAUSED")
              ?? list.data?.challenges[0]
              ?? null;

  const evalQ = useQuery<EvalResp>({
    queryKey: ["prop-eval", active?.id],
    queryFn: async () => {
      const r = await fetch(`/api/prop-challenges/${active!.id}/evaluate`, { method: "POST" });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: active != null,
    refetchInterval: 8000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/prop-challenges", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ paperAccountId, challengeName: name, startingBalance: 10000 }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prop-list"] }),
  });

  const transition = useMutation({
    mutationFn: async (status: "PAUSED"|"ACTIVE"|"CANCELED") => {
      const r = await fetch(`/api/prop-challenges/${active!.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prop-list"] }),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Prop Firm Challenge Mode</h1>
          <p className="text-xs text-warning">Practice/training only — does not promise funded-account approval or guaranteed profits.</p>
        </div>
        <span className="rounded bg-warning/15 px-3 py-1 text-xs font-bold text-white">SIMULATED</span>
      </header>

      {!active && (
        <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Start a practice challenge</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label><span className="text-txt-secondary">Demo account ID</span>
              <input type="number" value={paperAccountId} onChange={(e)=>setPaperAccountId(Number(e.target.value))} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
            </label>
            <label><span className="text-txt-secondary">Challenge name</span>
              <input value={name} onChange={(e)=>setName(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
            </label>
          </div>
          <button onClick={()=>create.mutate()} disabled={create.isPending} className="rounded bg-warning px-3 py-1.5 text-xs font-semibold text-white hover:bg-warning disabled:opacity-50">
            {create.isPending ? "Creating…" : "Start practice challenge"}
          </button>
          {create.isError && <p className="text-[11px] text-danger">{(create.error as Error).message}</p>}
        </div>
      )}

      {active && (
        <>
          <PropPassFailBanner status={active.status} reason={active.failureReason} />
          <div className="flex flex-wrap gap-2">
            {active.status === "ACTIVE" && (
              <button onClick={()=>transition.mutate("PAUSED")} className="rounded bg-warning/15 px-3 py-1 text-xs text-white hover:bg-warning">Pause</button>
            )}
            {active.status === "PAUSED" && (
              <button onClick={()=>transition.mutate("ACTIVE")} className="rounded bg-success/15 px-3 py-1 text-xs text-white hover:bg-success">Resume</button>
            )}
            {(active.status === "ACTIVE" || active.status === "PAUSED") && (
              <button onClick={()=>transition.mutate("CANCELED")} className="rounded bg-muted px-3 py-1 text-xs text-white hover:bg-muted">Cancel</button>
            )}
            <button onClick={()=>evalQ.refetch()} className="rounded bg-ruby/15 px-3 py-1 text-xs text-white hover:bg-ruby">Re-evaluate</button>
          </div>
          {evalQ.data && (
            <>
              <PropChallengeProgressCard summary={evalQ.data.summary} />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <PropProfitTargetMeter totalPct={evalQ.data.summary.totalPct} target={evalQ.data.summary.profitTarget} />
                <PropDrawdownMeter ddPct={evalQ.data.summary.maxDrawdownPct} limit={evalQ.data.summary.maxTotalDrawdown} />
                <PropDailyLossLimitCard worstPct={evalQ.data.summary.worstDayPct} worstDate={evalQ.data.summary.worstDayDate} limit={evalQ.data.summary.maxDailyLoss} />
              </div>
              <PropRuleViolationFeed violations={evalQ.data.violations} />
              <PropChallengeCalendar days={evalQ.data.days} />
              {(active.status === "ACTIVE" || active.status === "PAUSED") && (
                <PropExtendedRulesPanel
                  challengeId={active.id}
                  disabled={false}
                  rules={{
                    trailingDrawdownEnabled: (active.trailingDrawdownEnabled ?? 0) === 1,
                    trailingDrawdownAmount: active.trailingDrawdownAmount ?? 0.05,
                    trailingDrawdownType: active.trailingDrawdownType ?? "STATIC",
                    // Permissive defaults — match schema in lib/db/src/schema/propChallenges.ts.
                    maxRiskPerTrade: active.maxRiskPerTrade ?? 1.0,
                    maxOpenTrades: active.maxOpenTrades ?? 100,
                    maxPendingOrders: active.maxPendingOrders ?? 100,
                    maxPositionSize: active.maxPositionSize ?? 100,
                    newsTradingAllowed: (active.newsTradingAllowed ?? 1) === 1,
                    weekendHoldingAllowed: (active.weekendHoldingAllowed ?? 1) === 1,
                    overnightHoldingAllowed: (active.overnightHoldingAllowed ?? 1) === 1,
                    strictGuardrailsEnabled: (active.strictGuardrailsEnabled ?? 0) === 1,
                  }}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
