import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { StatusPill } from "@/components/ss/StatusPill";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

interface Scenario {
  scenarioId: string; title: string; symbol: string; timeframe: string;
  source: string; marketCondition: string; candleCount: number; notes: string;
}

interface RunResult {
  replay_run_id: string; scenario_id: string; status: string; symbol: string;
  candles_processed: number; decisions_created: number;
  simulated_trades_opened: number; simulated_trades_closed: number;
  wins: number; losses: number; net_pnl: number; win_rate: number;
  max_drawdown: number; profit_factor: number;
  warnings: string[]; errors: string[];
  report: {
    coach_notes: string[]; safety_notes: string[];
    playbook_recommendations: { type: string; message: string }[];
    mistake_patterns: { tag: string; count: number; note: string }[];
    should_promote_to_playbook: boolean; should_mark_for_review: boolean;
  };
}

export default function ReplaySimulator() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  async function loadScenarios() {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/replay/scenarios").then(x => x.json());
      setScenarios(r.scenarios ?? []);
      if (!selected && r.scenarios?.[0]) setSelected(r.scenarios[0].scenarioId);
    } catch (e) { setErr(`Failed to load scenarios: ${String(e)}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadScenarios(); }, []);

  async function createDemo() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/replay/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketCondition: "TRENDING_UP", candleCount: 80 }) }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      await loadScenarios();
      setSelected(r.scenario_id);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function runReplay() {
    if (!selected) return;
    setBusy(true); setErr(""); setResult(null);
    try {
      const r = await fetch("/api/replay/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario_id: selected, settings: { useSniperFilter: true, minConfidence: 55 } }) }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      setResult(r);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const scn = scenarios.find(s => s.scenarioId === selected);

  return (
    <PageShell
      title="Replay Simulator"
      description="Build JJ — Replay Simulator. Simulation only. Never places trades, never calls MT5, never recommends live trading."
      icon={<FlaskConical className="h-6 w-6" />}
      replayOnly
    >
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
            <label htmlFor="scenario-select" className="text-sm font-medium">Scenario:</label>
            <select
              id="scenario-select"
              className="border border-input rounded-md px-2 py-1.5 text-sm flex-1 min-w-[220px] bg-background"
              value={selected}
              onChange={e => setSelected(e.target.value)}
              aria-label="Select replay scenario"
            >
              <option value="">— pick one —</option>
              {scenarios.map(s => <option key={s.scenarioId} value={s.scenarioId}>{s.title} ({s.candleCount}c)</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={busy} onClick={createDemo}>+ New Synthetic</Button>
            <Button size="sm" disabled={busy || !selected} onClick={runReplay}>{busy ? "Running…" : "Run Replay"}</Button>
          </div>
          {scn && (
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
              <StatusPill status="REPLAY_ONLY" size="xs" label={scn.marketCondition} />
              <span>{scn.symbol} · {scn.timeframe} · {scn.source} · {scn.candleCount} candles</span>
            </div>
          )}
          {err && <ErrorState description={err} onRetry={loadScenarios} />}
        </CardContent>
      </Card>

      {loading && !result && <LoadingState label="Loading scenarios…" />}
      {!loading && scenarios.length === 0 && !result && (
        <EmptyState
          title="No replay scenarios yet"
          description="Replay is simulation only and never places real trades. Create a synthetic scenario to start."
          action={{ label: "Create demo scenario", onClick: createDemo }}
        />
      )}

      {busy && !result && (
        <Card>
          <CardContent className="pt-6">
            <LoadingState label="Replay running…" />
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <SectionHeader
              title="Replay Result"
              description="Simulation only — these numbers do not reflect live trading and do not guarantee future performance."
              actions={<StatusPill status={result.status === "OK" || result.status === "completed" ? "ACTIVE" : "PAUSED"} label={result.status.toUpperCase()} />}
            />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-sm">
              <Stat label="Candles" value={result.candles_processed} />
              <Stat label="Decisions" value={result.decisions_created} />
              <Stat label="Trades opened" value={result.simulated_trades_opened} />
              <Stat label="Trades closed" value={result.simulated_trades_closed} />
              <Stat label="Wins / Losses" value={`${result.wins} / ${result.losses}`} />
              <Stat label="Win rate" value={`${result.win_rate}%`} />
              <Stat label="Net P&L" value={result.net_pnl} />
              <Stat label="Max DD" value={result.max_drawdown} />
              <Stat label="Profit factor" value={result.profit_factor} />
            </div>
            {result.report.coach_notes.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mt-2">Coach notes</h3>
                <ul className="list-disc pl-5 text-sm space-y-0.5">{result.report.coach_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}
            <div>
              <h3 className="font-semibold text-sm">Playbook recommendations <span className="text-xs font-normal text-muted-foreground">(simulation-based)</span></h3>
              <ul className="list-disc pl-5 text-sm space-y-0.5">{result.report.playbook_recommendations.map((r, i) => <li key={i}><span className="font-mono text-xs bg-muted px-1 mr-1 rounded">{r.type}</span>{r.message}</li>)}</ul>
            </div>
            {result.report.mistake_patterns.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm">Mistakes detected in replay</h3>
                <ul className="list-disc pl-5 text-sm space-y-0.5">{result.report.mistake_patterns.map((m, i) => <li key={i}><b>{m.tag}</b> ×{m.count} — {m.note}</li>)}</ul>
              </div>
            )}
            <div className="text-xs text-muted-foreground border-t pt-2 space-y-0.5">
              {result.report.safety_notes.map((s, i) => <div key={i}>• {s}</div>)}
              <div className="italic">Replay results are educational. Sample size limits apply. Live trading remains disabled.</div>
            </div>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border rounded-md p-2 bg-card">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
