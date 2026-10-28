import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { StatusPill, type StatusKind } from "@/components/ss/StatusPill";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

interface Scenario {
  scenarioId: string; title: string; symbol: string; timeframe: string;
  source: string; marketCondition: string; candleCount: number; notes: string;
}

interface RunResult {
  replay_run_id: string; scenario_id: string; status: string; symbol: string;
  candles_processed: number; decisions_created: number;
  simulated_trades_opened: number; simulated_trades_closed: number;
  wins: number; losses: number; break_even?: number; net_pnl: number;
  // null when undefined: no closed trade (win rate) or no losing trade (profit factor).
  win_rate: number | null;
  max_drawdown: number; profit_factor: number | null;
  // P&L and drawdown are candle price differences x this size, not money.
  position_size?: number;
  warnings: string[]; errors: string[];
  report: {
    coach_notes: string[]; safety_notes: string[];
    playbook_recommendations: { type: string; message: string }[];
    mistake_patterns: { tag: string; count: number; note: string }[];
    should_promote_to_playbook: boolean; should_mark_for_review: boolean;
  };
}

// The engine returns COMPLETED, STOPPED or FAILED (upper case). Map each to a
// pill whose icon and accessible label match the text shown; anything
// unrecognised is disclosed as unknown, never as a finished run.
function runStatusPill(status: string): { kind: StatusKind; label: string; ariaLabel: string } {
  const raw = (status ?? "").trim();
  switch (raw.toUpperCase()) {
    case "COMPLETED": return { kind: "ACTIVE", label: "COMPLETED", ariaLabel: "status: completed" };
    case "STOPPED": return { kind: "PAUSED", label: "STOPPED", ariaLabel: "status: stopped" };
    case "FAILED": return { kind: "BLOCKED", label: "FAILED", ariaLabel: "status: failed" };
    default: {
      const shown = raw === "" ? "UNKNOWN" : raw.toUpperCase();
      return { kind: "INACTIVE", label: shown, ariaLabel: `status: unknown (${raw === "" ? "none reported" : raw})` };
    }
  }
}

// A scenario's market condition is a label, never a measurement: the
// generator setting for a synthetic scenario, the caller's label for an import
// (older imports with no label were stored as a defaulted RANGING).
function conditionLabel(s: Scenario): { label: string; aria: string } {
  const cond = (s.marketCondition ?? "").trim().toUpperCase();
  const src = (s.source ?? "").trim().toUpperCase();
  if (cond === "" || cond === "UNSPECIFIED") {
    return { label: "Condition not specified", aria: "market condition: not specified and not measured" };
  }
  const basis = src === "SYNTHETIC" ? "generator setting"
    : src === "IMPORTED" ? (cond === "RANGING" ? "import label or default" : "import label")
    : "label";
  return { label: `${cond} (${basis}, not measured)`, aria: `market condition: ${cond}, ${basis}, not measured from the candles` };
}

function sourceWord(source: string): string {
  const src = (source ?? "").trim().toLowerCase();
  return src === "" ? "source unknown" : src;
}

// Win rate needs at least one closed trade. An older server sent 0 here.
function winRateText(r: RunResult): string {
  if (!(r.simulated_trades_closed > 0) || r.win_rate == null) return "— (no closed trades)";
  return `${r.win_rate}%`;
}

// Profit factor is gross profit / gross loss, so it needs a losing trade. An
// older server sent the sentinel 999 (no losses) or 0 (no trades) here.
function profitFactorText(r: RunResult): string {
  if (!(r.losses > 0) || r.profit_factor == null) return r.wins > 0 ? "— (no losing trades)" : "— (no closed trades)";
  return String(r.profit_factor);
}

export default function ReplaySimulator() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // True while the last scenario-list read failed: the list is unknown, not empty.
  const [listFailed, setListFailed] = useState(false);

  async function loadScenarios() {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/replay/scenarios");
      const r = await res.json().catch(() => null) as { scenarios?: Scenario[]; error?: string } | null;
      if (!res.ok || !r || !Array.isArray(r.scenarios)) {
        throw new Error(r?.error ?? `HTTP ${res.status}`);
      }
      setScenarios(r.scenarios);
      setListFailed(false);
      if (!selected && r.scenarios[0]) setSelected(r.scenarios[0].scenarioId);
    } catch (e) {
      setListFailed(true);
      setErr(`Replay scenarios could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    }
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
              {scenarios.map(s => <option key={s.scenarioId} value={s.scenarioId}>{s.title} ({s.candleCount}c, {sourceWord(s.source)})</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={busy} onClick={createDemo}>+ New Synthetic</Button>
            <Button size="sm" disabled={busy || !selected} onClick={runReplay}>{busy ? "Running…" : "Run Replay"}</Button>
          </div>
          {scn && (
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
              {(() => { const c = conditionLabel(scn); return (
                <span data-testid="replay-scenario-condition">
                  <StatusPill status="REPLAY_ONLY" size="xs" label={c.label} ariaLabel={c.aria} />
                </span>
              ); })()}
              <span data-testid="replay-scenario-meta">
                {scn.symbol} · {scn.timeframe} · {scn.source} · {scn.candleCount} candles
                {(scn.source ?? "").toUpperCase() === "SYNTHETIC" && ` · generated prices, not real ${scn.symbol} market data`}
              </span>
            </div>
          )}
          {err && <ErrorState description={err} onRetry={loadScenarios} />}
        </CardContent>
      </Card>

      {loading && !result && <LoadingState label="Loading scenarios…" />}
      {!loading && !listFailed && scenarios.length === 0 && !result && (
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
              actions={(() => { const pill = runStatusPill(result.status); return <StatusPill status={pill.kind} label={pill.label} ariaLabel={pill.ariaLabel} />; })()}
            />
            {["FAILED", "STOPPED"].includes((result.status ?? "").toUpperCase()) && (
              <p className="text-xs text-amber-600" data-testid="replay-partial-note">
                This replay did not finish: it covers {result.candles_processed} of {scn?.scenarioId === result.scenario_id ? scn.candleCount : "the scenario's"} candles. The numbers below are partial.
              </p>
            )}
            {!["COMPLETED", "FAILED", "STOPPED"].includes((result.status ?? "").toUpperCase()) && (
              <p className="text-xs text-amber-600" data-testid="replay-partial-note">
                The server reported a status this page does not recognise, so it cannot confirm the replay finished.
              </p>
            )}
            {(result.errors ?? []).length > 0 && (
              <ErrorState title="Replay error" description={(result.errors ?? []).join(" · ")} />
            )}
            {(result.warnings ?? []).length > 0 && (
              <ul className="text-xs text-amber-600 list-disc pl-5 space-y-0.5" data-testid="replay-warnings">
                {(result.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-sm">
              <Stat id="candles" label="Candles" value={result.candles_processed} />
              <Stat id="decisions" label="Decisions" value={result.decisions_created} />
              <Stat id="opened" label="Trades opened" value={result.simulated_trades_opened} />
              <Stat id="closed" label="Trades closed" value={result.simulated_trades_closed} />
              <Stat id="wins-losses" label="Wins / Losses / Even" value={`${result.wins} / ${result.losses} / ${result.break_even ?? "—"}`} />
              <Stat id="win-rate" label="Win rate" value={winRateText(result)} />
              <Stat id="net-pnl" label="Net P&L" value={`${result.net_pnl} pts`} />
              <Stat id="max-dd" label="Max DD" value={`${result.max_drawdown} pts`} />
              <Stat id="profit-factor" label="Profit factor" value={profitFactorText(result)} />
            </div>
            <p className="text-xs text-muted-foreground" data-testid="replay-pnl-unit">
              P&L and drawdown are price points: candle price differences × position size {result.position_size ?? "(not reported)"} on this scenario's candles — not money.
            </p>
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

function Stat({ id, label, value }: { id: string; label: string; value: string | number }) {
  return (
    <div className="border border-border rounded-md p-2 bg-card" data-testid={`replay-stat-${id}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
