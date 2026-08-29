import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { StatusPill } from "@/components/ss/StatusPill";
import { LoadingState, EmptyState, ErrorState } from "@/components/ss/States";

type Imp = {
  importId: string; symbol: string; timeframe: string; source: string; status: string;
  candlesReceived: number; candlesValid: number; candlesRejected: number;
  dataQuality: { status: string; warnings: string[]; errors: string[] };
  canUseForReplay: boolean; canUseAsDDFallback: boolean;
};

export default function DataImportPage() {
  const [imports, setImports] = useState<Imp[]>([]);
  const [logs, setLogs] = useState<{ eventType: string; severity: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  async function refresh() {
    setLoading(true); setErr("");
    try {
      const [i, l] = await Promise.all([
        fetch("/api/data-import/imports?limit=20").then(r => r.json()),
        fetch("/api/data-import/logs?limit=20").then(r => r.json()),
      ]);
      setImports(i.imports ?? []);
      setLogs(l.logs ?? []);
    } catch (e) { setErr(String(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function runDemo() {
    setBusy(true); setMsg(""); setErr("");
    try {
      const r = await fetch("/api/data-import/demo", { method: "POST" }).then(r => r.json());
      setMsg(`Demo import ${r.import_id} → ${r.status} (valid ${r.candlesValid}, rejected ${r.candlesRejected})`);
      await refresh();
    } catch (e) { setErr(`Demo import failed: ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function makeReplay(id: string) {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/data-import/imports/${id}/create-replay-scenario`, { method: "POST" }).then(r => r.json());
      setMsg(r.error ? `Error: ${r.error}` : `Created replay scenario ${r.scenario_id} (${r.candles} candles)`);
    } catch (e) { setErr(`Create replay scenario failed: ${String(e)}`); }
    finally { setBusy(false); }
  }

  return (
    <PageShell
      title="Data Import"
      description="Build KK — Data Import. Imported candles are labelled IMPORTED — never live data. Never places trades, never recommends live trading."
      icon={<Database className="h-6 w-6" />}
      readOnly
      actions={
        <>
          <Button size="sm" disabled={busy} onClick={runDemo}>{busy ? "Importing…" : "Run demo import"}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>Refresh</Button>
        </>
      }
    >
      {msg && <Alert><AlertDescription className="text-xs">{msg}</AlertDescription></Alert>}
      {err && <ErrorState description={err} onRetry={refresh} />}

      <Card>
        <CardContent className="pt-6">
          <SectionHeader title="Imports" description="All rows are imported historical data — IMPORTED, not live." />
          {loading ? <LoadingState label="Loading imports…" />
            : imports.length === 0
              ? <EmptyState title="No imports yet" description="Run a demo import to populate the table. Imports are read-only candle data and never become live trades." action={{ label: "Run demo import", onClick: runDemo }} />
              : (
                <>
                  {/* Mobile card view */}
                  <div className="md:hidden space-y-2">
                    {imports.map(i => (
                      <div key={i.importId} className="border border-border rounded-md p-3 text-sm space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-mono text-xs text-muted-foreground truncate">{i.importId.slice(0, 18)}…</div>
                          <StatusPill status="READ_ONLY" size="xs" label={i.status.toUpperCase()} />
                        </div>
                        <div className="font-semibold">{i.symbol} <span className="text-xs font-normal text-muted-foreground">· {i.timeframe} · {i.source}</span></div>
                        <div className="text-xs grid grid-cols-3 gap-1">
                          <div>recv <b>{i.candlesReceived}</b></div>
                          <div>valid <b className="text-success">{i.candlesValid}</b></div>
                          <div>rej <b className="text-danger">{i.candlesRejected}</b></div>
                        </div>
                        <div className="text-xs">quality: <b>{i.dataQuality?.status}</b></div>
                        {i.canUseForReplay && (
                          <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => makeReplay(i.importId)}>→ Use as Replay scenario</Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Desktop table view */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted text-xs uppercase">
                        <tr>
                          <th scope="col" className="px-2 py-1.5 text-left">Import</th>
                          <th scope="col">Symbol</th><th scope="col">TF</th><th scope="col">Source</th><th scope="col">Status</th>
                          <th scope="col">Recv</th><th scope="col">Valid</th><th scope="col">Reject</th>
                          <th scope="col">Quality</th><th scope="col">Replay</th><th scope="col">DD-fallback</th><th scope="col"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {imports.map(i => (
                          <tr key={i.importId} className="border-t border-border">
                            <td className="px-2 py-1.5 font-mono text-xs">{i.importId.slice(0, 18)}…</td>
                            <td className="text-center">{i.symbol}</td>
                            <td className="text-center">{i.timeframe}</td>
                            <td className="text-center">{i.source}</td>
                            <td className="text-center"><StatusPill status="READ_ONLY" size="xs" label={i.status.toUpperCase()} /></td>
                            <td className="text-center tabular-nums">{i.candlesReceived}</td>
                            <td className="text-center tabular-nums text-success">{i.candlesValid}</td>
                            <td className="text-center tabular-nums text-danger">{i.candlesRejected}</td>
                            <td className="text-center">{i.dataQuality?.status}</td>
                            <td className="text-center">{i.canUseForReplay ? "✓" : "—"}</td>
                            <td className="text-center">{i.canUseAsDDFallback ? "✓" : "—"}</td>
                            <td className="text-center">
                              {i.canUseForReplay && (
                                <Button size="sm" variant="outline" onClick={() => makeReplay(i.importId)}>→ Replay</Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <SectionHeader title="Recent import logs" />
          {logs.length === 0
            ? <p className="text-xs text-muted-foreground">No log entries yet.</p>
            : <ul className="text-xs max-h-64 overflow-auto font-mono space-y-0.5">
                {logs.map((l, k) => <li key={k}><span className="text-muted-foreground">[{l.severity}]</span> {l.eventType} — {l.message}</li>)}
              </ul>}
        </CardContent>
      </Card>
    </PageShell>
  );
}
