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
      const r = await fetch("/api/strategy-lab/experiments?limit=20").then(x => x.json());
      setExperiments(r.experiments ?? []);
    } catch (e) { setErr(String(e)); } finally { setLoading(false); }
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
      title="Strategy Lab (demo only)"
      description="Runs one fixed demo experiment. There is no setup builder here yet — see the note below for exactly what this page can and cannot do."
      icon={<Brain className="h-6 w-6" />}
      replayOnly
      actions={<Button size="sm" disabled={busy} onClick={runDemo}>{busy ? "Running demo…" : "Run demo experiment"}</Button>}
    >
      {/* HONESTY (audit rank 71): the page described itself as "Compare playbook
          setups across replay scenarios", but its only control posts to
          /api/strategy-lab/demo, which hardcodes V75 / M5 / three synthetic
          scenarios and passes an empty playbookEntryId — so no playbook is
          applied and every run is the identical experiment. The builder and the
          compare view the API supports have no caller in this app. Rather than
          keep the promise, the page now states what it actually is. */}
      <Card className="border-warning/40 bg-warning/10">
        <CardContent className="pt-4 text-xs space-y-1">
          <p className="font-semibold text-warning">This page is a fixed demo, not a lab.</p>
          <p className="text-warning/80">
            The button runs one hardcoded experiment: <span className="font-mono">V75</span> on{" "}
            <span className="font-mono">M5</span> across three generated scenarios
            (trending up, trending down, ranging), with <strong>no playbook applied</strong>.
            Every press produces the same experiment, so repeated runs are duplicates, not
            variations.
          </p>
          <p className="text-warning/80">
            Not available here: choosing a symbol, timeframe, scenario or playbook entry;
            editing settings; and the side-by-side compare view. The backend supports those
            endpoints; this page has no interface for them yet. Nothing here is a
            recommendation and no trade is ever placed.
          </p>
        </CardContent>
      </Card>

      {err && <ErrorState description={err} onRetry={load} />}
      {loading && <LoadingState label="Loading experiments…" />}

      {!loading && experiments.length === 0 && (
        <EmptyState
          title="No experiments yet"
          description="The demo experiment runs three generated scenarios on V75 M5 with no playbook. Results are simulation on generated candles and say nothing about future performance."
          action={{ label: "Run demo experiment", onClick: runDemo }}
        />
      )}

      <div className="space-y-3">
        {experiments.map(e => (
          <Card key={e.experimentId}>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="font-semibold text-sm">{e.title}</div>
                <StatusPill status={e.status === "completed" ? "ACTIVE" : "PENDING"} label={e.status.toUpperCase()} size="xs" />
              </div>
              <div className="text-xs text-muted-foreground font-mono mt-1">{e.experimentId}</div>
              {e.resultSummary?.scenariosRun != null && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-sm">
                  <Stat label="Scenarios" value={e.resultSummary.scenariosRun} />
                  <Stat label="Total trades" value={e.resultSummary.totalTrades ?? 0} />
                  <Stat label="Net" value={e.resultSummary.totalNet ?? 0} />
                  <Stat label="Win rate" value={`${e.resultSummary.aggregateWinRate ?? 0}%`} />
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border rounded-md p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
