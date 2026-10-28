import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell } from "@/components/ss/PageShell";
import { StatusPill } from "@/components/ss/StatusPill";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

interface Experiment {
  experimentId: string; title: string; status: string; symbol: string;
  resultSummary: {
    scenariosRun?: number; totalTrades?: number; totalNet?: number; aggregateWinRate?: number;
    ranking?: { scenarioId: string; netPnl: number; winRate: number }[];
    perScenario?: { scenarioId: string; replayRunId: string; trades: number }[];
    recommendations?: { type: string; message: string }[];
  };
}

export default function StrategyLab() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    try {
      setErr("");
      const res = await fetch("/api/strategy-lab/experiments?limit=20");
      let r: { experiments?: unknown; error?: unknown } = {};
      try { r = await res.json(); } catch { r = {}; }
      if (!res.ok) throw new Error(typeof r.error === "string" ? r.error : `HTTP ${res.status}`);
      if (!Array.isArray(r.experiments)) throw new Error("Response did not include an experiments list.");
      setExperiments(r.experiments as Experiment[]);
    } catch (e) {
      setExperiments([]);
      setErr(`Could not load experiments: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function runDemo() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/strategy-lab/demo", { method: "POST" }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      await load();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  return (
    <PageShell
      title="Strategy Lab"
      description="Build JJ — Strategy Lab. Compare playbook setups across replay scenarios. Never places trades, never recommends live trading."
      icon={<Brain className="h-6 w-6" />}
      replayOnly
      actions={<Button size="sm" disabled={busy} onClick={runDemo}>{busy ? "Running demo…" : "Run Demo Experiment"}</Button>}
    >
      {err && <ErrorState description={err} onRetry={load} />}
      {loading && <LoadingState label="Loading experiments…" />}

      {!loading && !err && experiments.length === 0 && (
        <EmptyState
          title="No experiments yet"
          description="Strategy Lab compares playbook setups across replay scenarios. All results are simulation only and do not guarantee future performance."
          action={{ label: "Run demo experiment", onClick: runDemo }}
        />
      )}

      <div className="space-y-3">
        {experiments.map(e => (
          <Card key={e.experimentId}>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="font-semibold text-sm">{e.title}</div>
                <StatusPill status={e.status.toUpperCase() === "COMPLETED" ? "ACTIVE" : "PENDING"} label={e.status.toUpperCase()} size="xs" />
              </div>
              <div className="text-xs text-muted-foreground font-mono mt-1">{e.experimentId}</div>
              {e.resultSummary?.scenariosRun != null && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-sm">
                  <ExperimentStats summary={e.resultSummary} />
                </div>
              )}
              {(e.resultSummary?.ranking ?? []).length > 0 && (
                <div className="mt-3 text-xs">
                  <div className="font-semibold mb-1">Setup ranking</div>
                  <ul className="space-y-0.5">{e.resultSummary.ranking!.map((r, i) => <li key={i}>#{i + 1} <span className="font-mono">{r.scenarioId.slice(0, 22)}…</span> — net {r.netPnl}, wr {r.winRate}%</li>)}</ul>
                </div>
              )}
              {(e.resultSummary?.recommendations ?? []).length > 0 && (
                <div className="mt-3 text-xs">
                  <div className="font-semibold mb-1">Recommendations <span className="font-normal text-muted-foreground">(replay-based, sample size limited)</span></div>
                  {e.resultSummary.recommendations!.map((r, i) => <div key={i}><span className="font-mono bg-muted px-1 mr-1 rounded">{r.type}</span>{r.message}</div>)}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}

const DASH = "—";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Missing fields render "—", never a measured 0. Scenarios that were not
// found on the server (replayRunId "") are not counted as replayed. A win
// rate over zero trades does not exist. Replay net is the sum of
// (price move × position size) across trades — not account currency.
function ExperimentStats({ summary }: { summary: Experiment["resultSummary"] }) {
  const listed = summary.scenariosRun;
  const per = Array.isArray(summary.perScenario) ? summary.perScenario : null;
  const replayed = per ? per.filter((p) => typeof p.replayRunId === "string" && p.replayRunId.length > 0).length : null;
  const trades = isNum(summary.totalTrades) ? summary.totalTrades : null;
  const scenariosLabel = replayed != null ? "Scenarios replayed" : "Scenarios listed";
  const scenariosValue = replayed != null && per ? `${replayed} of ${per.length}` : isNum(listed) ? String(listed) : DASH;
  const winRate = trades != null && trades > 0 && isNum(summary.aggregateWinRate) ? `${summary.aggregateWinRate}%` : DASH;
  return (
    <>
      <Stat id="scenarios" label={scenariosLabel} value={scenariosValue} />
      <Stat id="trades" label="Total trades" value={trades != null ? String(trades) : DASH} />
      <Stat id="net" label="Replay net" value={isNum(summary.totalNet) ? String(summary.totalNet) : DASH} hint="price units × size, not account currency" />
      <Stat id="winrate" label="Win rate" value={winRate} hint={trades === 0 ? "no trades" : undefined} />
    </>
  );
}

function Stat({ id, label, value, hint }: { id: string; label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border rounded-md p-2" data-testid={`strategy-lab-stat-${id}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums" data-stat-value>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
