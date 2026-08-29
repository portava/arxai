import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { StatusPill } from "@/components/ss/StatusPill";
import { LoadingState, EmptyState, BlockedState, ErrorState } from "@/components/ss/States";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type Snapshot = {
  connector_id: string; provider: string; mode: string; connected: boolean;
  account: { accountIdMasked: string; currency: string; balance: number; equity: number; margin: number; freeMargin: number; leverage: number; serverTime: string } | null;
  symbols: { symbol: string; description: string; digits: number }[];
  openPositions: { ticket: string; symbol: string; side: string; volume: number; pnl: number }[];
  latestQuotes: { symbol: string; bid: number; ask: number; spread: number; ts: string }[];
  dataQuality: { status: string; latencyMs: number; warnings: string[]; errors: string[] };
};

function BrokerReadOnlyContent() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [safety, setSafety] = useState<{ safe: boolean; brokerModeEnv: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");

  async function loadStatus() {
    setLoading(true); setErr("");
    try {
      const response = await fetch("/api/broker-readonly/status", { credentials: "include" });
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in required." : "Status unavailable.");
      const r = await response.json();
      setSafety(r.status?.safety ?? null);
    } catch (e) { setErr(`Failed to load broker status: ${String(e)}`); }
    finally { setLoading(false); }
  }
  async function runDemo() {
    setBusy(true); setErr("");
    try {
      const response = await fetch("/api/broker-readonly/demo", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in required." : "Snapshot unavailable.");
      const r = await response.json();
      setSnap(r.snapshot ?? null);
    } catch (e) { setErr(`Demo snapshot failed: ${String(e)}`); }
    finally { setBusy(false); }
  }
  useEffect(() => { void loadStatus(); }, []);

  return (
    <PageShell
      title="Broker (READ ONLY)"
      description="Build KK — Broker Read-Only. Account / symbol / position snapshots only. Never places trades, never modifies positions, never exposes secrets."
      icon={<FileText className="h-6 w-6" />}
      readOnly
      actions={
        <>
          <Button size="sm" asChild data-testid="button-download-bridge-zip">
            <a href="/api/mt5/bridge-package/zip" download>Download MT5 Bridge Package</a>
          </Button>
          <Button size="sm" variant="outline" asChild data-testid="button-open-setup-wizard">
            <a href="/mt5-setup">MT5 Setup Wizard</a>
          </Button>
          <Button size="sm" disabled={busy} onClick={runDemo}>{busy ? "Loading…" : "Run demo snapshot"}</Button>
          <Button size="sm" variant="outline" onClick={loadStatus}>Refresh status</Button>
        </>
      }
    >
      {err && <ErrorState description={err} onRetry={loadStatus} />}
      {loading && !err && <LoadingState label="Checking broker safety…" />}

      {safety && (
        safety.safe
          ? (
            <Card>
              <CardContent className="pt-4 flex items-center gap-2 flex-wrap text-sm">
                <StatusPill status="READ_ONLY" label="SAFE · READ ONLY" />
                <span className="text-muted-foreground">env=<code className="font-mono text-xs">{safety.brokerModeEnv}</code></span>
                <span className="text-muted-foreground">{safety.reason}</span>
              </CardContent>
            </Card>
          )
          : (
            <BlockedState
              what="Broker connector rejected"
              why={safety.reason}
              blockingSystem="KK · Broker (READ ONLY)"
              safeNextStep="Confirm BROKER_MODE is set to READ_ONLY. Live execution is not available in this app."
              link={{ label: "Open Help Center", href: "/help" }}
            />
          )
      )}

      {!snap && !loading && (
        <EmptyState
          title="No broker snapshot loaded"
          description="Run a demo snapshot to view masked account, symbols, positions and quotes. The broker connector is read-only — no orders are ever sent."
          action={{ label: "Run demo snapshot", onClick: runDemo }}
        />
      )}

      {snap && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="pt-4">
              <SectionHeader
                title="Account (masked)"
                actions={<StatusPill status={snap.connected ? "ACTIVE" : "INACTIVE"} size="xs" label={snap.connected ? "CONNECTED" : "DISCONNECTED"} />}
              />
              {snap.account ? (
                <dl className="text-sm grid grid-cols-2 gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Account ID</dt><dd className="font-mono">{snap.account.accountIdMasked}</dd>
                  <dt className="text-muted-foreground">Currency</dt><dd>{snap.account.currency}</dd>
                  <dt className="text-muted-foreground">Balance</dt><dd className="tabular-nums">{snap.account.balance}</dd>
                  <dt className="text-muted-foreground">Equity</dt><dd className="tabular-nums">{snap.account.equity}</dd>
                  <dt className="text-muted-foreground">Free margin</dt><dd className="tabular-nums">{snap.account.freeMargin}</dd>
                  <dt className="text-muted-foreground">Leverage</dt><dd>1:{snap.account.leverage}</dd>
                  <dt className="text-muted-foreground">Server time</dt><dd className="font-mono text-xs">{snap.account.serverTime}</dd>
                </dl>
              ) : <p className="text-sm text-muted-foreground">No account snapshot available.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <SectionHeader title={`Symbols (${snap.symbols.length})`} />
              {snap.symbols.length === 0
                ? <p className="text-sm text-muted-foreground">No symbols.</p>
                : <ul className="text-sm space-y-0.5">{snap.symbols.map(s => <li key={s.symbol}><span className="font-mono">{s.symbol}</span> — {s.description}</li>)}</ul>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <SectionHeader title={`Open positions (${snap.openPositions.length})`} description="Read-only view — no close/modify controls." />
              {snap.openPositions.length === 0
                ? <p className="text-sm text-muted-foreground">No open positions.</p>
                : <ul className="text-sm space-y-0.5">{snap.openPositions.map(p => <li key={p.ticket}><span className="font-mono text-xs">{p.ticket}</span> {p.symbol} {p.side} {p.volume} @ pnl <span className="tabular-nums">{p.pnl}</span></li>)}</ul>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <SectionHeader title="Latest quotes" />
              <ul className="text-sm space-y-0.5">
                {snap.latestQuotes.map(q => <li key={q.symbol}><span className="font-mono">{q.symbol}</span> — bid {q.bid} / ask {q.ask} <span className="text-muted-foreground">(spread {q.spread})</span></li>)}
              </ul>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardContent className="pt-4 text-sm space-y-2">
              <SectionHeader
                title="Data quality"
                actions={<StatusPill status={snap.dataQuality.status === "GOOD" ? "ACTIVE" : "PAUSED"} size="xs" label={snap.dataQuality.status} />}
              />
              <div className="text-muted-foreground">latency {snap.dataQuality.latencyMs}ms</div>
              {snap.dataQuality.warnings.length > 0 && <ul className="text-warning list-disc pl-5">{snap.dataQuality.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
              {snap.dataQuality.errors.length > 0 && <ul className="text-danger list-disc pl-5">{snap.dataQuality.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              <p className="text-xs text-muted-foreground italic border-t pt-2">No live execution buttons. Live trading remains disabled.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}

export default function BrokerReadOnlyPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Broker (READ ONLY)"
      pageDescription="Broker read-only diagnostics"
    >
      <BrokerReadOnlyContent />
    </AdminDiagnosticsGate>
  );
}
