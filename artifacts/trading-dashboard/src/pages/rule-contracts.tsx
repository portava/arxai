import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RuleContractBuilder, SessionCommitmentScreen, RuleComplianceCard,
  RuleViolationFeed, AccountabilityScoreCard,
} from "@/components/ruleContracts";

interface Contract {
  id: number; contractName: string;
  maxTradesPerDay: number | null; maxDailyLossPercent: number | null;
  maxRiskPerTradePercent: number | null; allowedSessions: string; allowedSymbols: string;
  requiredRrMinimum: number | null; cooldownAfterLosses: number | null;
  noTradeConditions: string; isActive: number;
}
interface Commitment { id: number; commitmentText: string; status: string; sessionDate: string; startedAt: string }
interface EvalResp {
  summary: {
    tradesEvaluated: number; respectedCount: number; accountabilityScore: number;
    totalPnl: number; consecLosses: number; cooldownTriggered: boolean;
    hardCount: number; warnCount: number; sessionDate: string; contractId: number;
  };
  violations: Array<{ type: string; severity: "INFO"|"WARN"|"HARD"; message: string; tradeId?: number | null }>;
}

export default function RuleContractsPage() {
  const qc = useQueryClient();

  const active = useQuery<{ contract: Contract }>({
    queryKey: ["rc-active"],
    queryFn: async () => {
      const r = await fetch("/api/rule-contracts/active");
      if (r.status === 404) throw new Error("none");
      return r.json();
    },
    retry: false,
  });
  const contract = active.data?.contract ?? null;

  const commit = useQuery<{ commitment: Commitment }>({
    queryKey: ["sc-active"],
    queryFn: async () => {
      const r = await fetch("/api/session-commitments/active");
      if (r.status === 404) throw new Error("none");
      return r.json();
    },
    retry: false,
  });
  const activeCommitment = commit.data?.commitment ?? null;

  const evalQ = useQuery<EvalResp>({
    queryKey: ["rc-eval", contract?.id],
    queryFn: async () => {
      const r = await fetch(`/api/rule-contracts/${contract!.id}/evaluate`, { method: "POST" });
      if (!r.ok) throw new Error("eval failed");
      return r.json();
    },
    enabled: contract != null,
    refetchInterval: 8000,
  });

  const create = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch("/api/rule-contracts", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error || "failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rc-active"] }),
  });

  const startCommit = useMutation({
    mutationFn: async (text: string) => {
      const r = await fetch("/api/session-commitments", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contractId: contract!.id, commitmentText: text }) });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sc-active"] }),
  });

  const endCommit = useMutation({
    mutationFn: async (status: "ENDED"|"ABANDONED") => {
      const r = await fetch(`/api/session-commitments/${activeCommitment!.id}/end`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sc-active"] }),
  });

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-100">Rule contracts & accountability</h1>
        <p className="text-xs text-slate-400">Soft warnings to support discipline. Does not enforce hard trade locks or guarantee profits.</p>
      </header>

      {!contract && <RuleContractBuilder onSubmit={create.mutate} saving={create.isPending} />}

      {contract && (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-3">
              <SessionCommitmentScreen
                active={activeCommitment}
                onStart={startCommit.mutate}
                onEnd={endCommit.mutate}
                busy={startCommit.isPending || endCommit.isPending}
              />
              {evalQ.data && <RuleComplianceCard summary={evalQ.data.summary} />}
              {evalQ.data && <RuleViolationFeed violations={evalQ.data.violations} />}
            </div>
            <div className="space-y-3">
              {evalQ.data && <AccountabilityScoreCard score={evalQ.data.summary.accountabilityScore} hardCount={evalQ.data.summary.hardCount} />}
              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                <h3 className="text-sm font-semibold text-slate-100">Active contract</h3>
                <dl className="mt-2 space-y-1 text-[11px] text-slate-300">
                  <div className="flex justify-between"><dt className="text-slate-500">Name</dt><dd>{contract.contractName}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Max trades/day</dt><dd>{contract.maxTradesPerDay ?? "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Max daily loss</dt><dd>{contract.maxDailyLossPercent != null ? `${(contract.maxDailyLossPercent*100).toFixed(2)}%` : "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Max risk/trade</dt><dd>{contract.maxRiskPerTradePercent != null ? `${(contract.maxRiskPerTradePercent*100).toFixed(2)}%` : "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Sessions</dt><dd className="font-mono">{contract.allowedSessions}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Symbols</dt><dd className="font-mono">{contract.allowedSymbols || "any"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Min R:R</dt><dd>{contract.requiredRrMinimum ?? "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Cooldown</dt><dd>{contract.cooldownAfterLosses ?? "—"} losses</dd></div>
                </dl>
              </div>
            </div>
          </div>

          <details className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
            <summary className="cursor-pointer text-xs font-semibold text-slate-300">Edit contract</summary>
            <div className="mt-3">
              <RuleContractBuilder initial={{
                contractName: contract.contractName,
                maxTradesPerDay: contract.maxTradesPerDay ?? undefined,
                maxDailyLossPercent: contract.maxDailyLossPercent ?? undefined,
                maxRiskPerTradePercent: contract.maxRiskPerTradePercent ?? undefined,
                allowedSessions: contract.allowedSessions,
                allowedSymbols: contract.allowedSymbols,
                requiredRrMinimum: contract.requiredRrMinimum ?? undefined,
                cooldownAfterLosses: contract.cooldownAfterLosses ?? undefined,
                noTradeConditions: contract.noTradeConditions,
              }} onSubmit={create.mutate} saving={create.isPending} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
