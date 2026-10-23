import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Database, Gauge } from "lucide-react";
import { setPerfTransportEnabled } from "@/lib/perf";
import { WorkflowHealthCard } from "@/components/admin/WorkflowHealthCard";
import { ChartTruthHealthCard } from "@/components/admin/ChartTruthHealthCard";
import { CandleDepthDiagnosticsCard } from "@/components/admin/CandleDepthDiagnosticsCard";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface CacheRuntime {
  mode: "in-process" | "distributed";
  instanceId: string;
  pid: number;
  namespaces: Array<{ name: string; ttlMs: number; size: number }>;
  distributedAdapterImplemented: boolean;
  modeMismatchWarning: boolean;
  notes: string[];
}

export default function AdminDiagnostics() {
  const { name } = useAssistantName();
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [cache, setCache] = useState<CacheRuntime | null>(null);

  async function fetchIt() {
    setBusy(true);
    try {
      const r = await fetch("/api/export/diagnostics", { headers: { "x-security-role": "ADMIN" } });
      setPkg(await r.json());
    } finally { setBusy(false); }
  }

  async function fetchCache() {
    try {
      const r = await fetch(`${BASE}/api/admin/performance/cache-mode`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      if (r.ok) setCache(await r.json());
    } catch { /* ignore — admin-only diagnostic */ }
  }

  useEffect(() => { void fetchIt(); void fetchCache(); }, []);

  function download() {
    if (!pkg) return;
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `diagnostics_${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4 p-1" data-testid="page-admin-diagnostics">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Diagnostics Export</h1>
          <p className="text-sm text-muted-foreground">Generate a sanitized diagnostic package. Excludes secrets, MT5 tokens, and API keys by construction.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void fetchIt()} disabled={busy}>{busy ? "Loading…" : "Refresh"}</Button>
          <Button onClick={download} disabled={!pkg} data-testid="diag-download">Download .json</Button>
        </div>
      </div>
      <WorkflowHealthCard />
      <ChartTruthHealthCard />
      <CandleDepthDiagnosticsCard />
      {cache && (
        <Card data-testid="card-cache-runtime">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4" />
              Cache & runtime
              <Badge
                className={cache.mode === "distributed"
                  ? "bg-success/20 text-success"
                  : "bg-warning/20 text-warning"}
                data-testid="badge-cache-mode"
              >Current cache mode: {cache.mode}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div><span className="text-muted-foreground">Instance ID:</span> <span className="font-mono">{cache.instanceId}</span></div>
              <div><span className="text-muted-foreground">PID:</span> <span className="font-mono">{cache.pid}</span></div>
              <div><span className="text-muted-foreground">Distributed adapter:</span> {cache.distributedAdapterImplemented ? "wired" : "not wired"}</div>
            </div>
            <div className="text-xs">
              <div className="text-muted-foreground mb-1">Namespaces</div>
              {cache.namespaces.length === 0 && <div className="font-mono text-muted-foreground">(no caches active yet)</div>}
              {cache.namespaces.map((n) => (
                <div key={n.name} className="font-mono flex gap-3" data-testid={`cache-ns-${n.name}`}>
                  <span>{n.name}</span>
                  <span className="text-muted-foreground">TTL {Math.round(n.ttlMs / 1000)}s</span>
                  <span className="text-muted-foreground">size {n.size}</span>
                </div>
              ))}
            </div>
            {cache.mode === "in-process" && (
              <Alert variant="default" className="border-warning/40 bg-warning/5" data-testid="alert-cache-in-process">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertTitle>Horizontal-scale warning</AlertTitle>
                <AlertDescription>
                  Cache state is local to this server instance. If the API is horizontally scaled,
                  cache hit rates will be uneven across replicas and {name} Market Intelligence will
                  recompute per replica. Wire a distributed adapter (e.g. Redis) before scaling out.
                </AlertDescription>
              </Alert>
            )}
            {cache.modeMismatchWarning && (
              <Alert variant="destructive" data-testid="alert-cache-mode-mismatch">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Configuration mismatch</AlertTitle>
                <AlertDescription>
                  ARX_CACHE_MODE=distributed is set but no distributed adapter is wired yet.
                  Falling back to in-process. Wire Redis before relying on it.
                </AlertDescription>
              </Alert>
            )}
            {cache.notes.map((n, i) => (
              <p key={i} className="text-[11px] text-muted-foreground">{n}</p>
            ))}
          </CardContent>
        </Card>
      )}
      <PerfPanel />
      {pkg && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Package
              <Badge className="bg-primary/20 text-primary font-mono">{String(pkg["version"] ?? "?")}</Badge>
              <Badge className="bg-warning/20 text-warning">{String(pkg["stage"] ?? "?")}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-[10px] leading-snug max-h-[60vh] overflow-auto font-mono">{JSON.stringify(pkg, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// PART A — Recent Slow Actions panel.
// Admin-only readout of the in-memory perfRecorder ring buffer. Pulls
// both the rolling action summary (p50/p95/max) and the most-recent slow
// rows. We deliberately do NOT poll aggressively — every 15s is enough
// for an operator-facing diagnostic, and the global QueryClient default
// stops it entirely on hidden tabs.

interface PerfRow {
  id: number;
  recordedAt: number;
  source: "server" | "client";
  action: string;
  page?: string | null;
  method?: string | null;
  status?: number | null;
  userId?: number | null;
  totalMs: number;
  uiFeedbackMs?: number | null;
  frontendRenderMs?: number | null;
  apiMs?: number | null;
  dbMs?: number | null;
  feedMs?: number | null;
  cacheHit?: boolean | null;
  bottleneck?: string | null;
  viewport?: string | null;
  slow: boolean;
}
interface PerfSummaryRow {
  action: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowCount: number;
}

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1) return "0";
  if (v < 1000) return `${Math.round(v)}`;
  return `${(v / 1000).toFixed(2)}s`;
}

function PerfPanel() {
  const { name } = useAssistantName();
  const [rows, setRows] = useState<PerfRow[]>([]);
  const [summary, setSummary] = useState<PerfSummaryRow[]>([]);
  const [slowOnly, setSlowOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The admin diagnostics page is the only surface that ever sees perf
  // data, so it's also the only place that should turn on the client-side
  // perf transport. Reaching this component already implies an
  // admin-capable session (the page itself sends `x-security-role: ADMIN`
  // headers everywhere). Flip the global flag on mount so subsequent
  // client-side `markActionEnd` slow rows get flushed — and flip it back
  // off on unmount so a non-admin tab on the same browser doesn't
  // accidentally inherit it.
  useEffect(() => {
    setPerfTransportEnabled(true);
    return () => setPerfTransportEnabled(false);
  }, []);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const [a, b] = await Promise.all([
        fetch(`${BASE}/api/admin/performance/recent-actions?limit=200${slowOnly ? "&slowOnly=1" : ""}`, {
          credentials: "include", headers: { "x-security-role": "ADMIN" },
        }).then((r) => r.json()),
        fetch(`${BASE}/api/admin/performance/action-summary`, {
          credentials: "include", headers: { "x-security-role": "ADMIN" },
        }).then((r) => r.json()),
      ]);
      setRows(Array.isArray(a?.rows) ? a.rows : []);
      setSummary(Array.isArray(b?.actions) ? b.actions : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load perf data");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [slowOnly]);

  const top = useMemo(() => summary.slice(0, 15), [summary]);

  return (
    <Card data-testid="card-perf-panel">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" /> Performance Diagnostics
          <Badge variant="outline" className="ml-2 font-mono text-[10px]">in-memory ring</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy} data-testid="button-perf-refresh">
            {busy ? "Loading…" : "Refresh"}
          </Button>
          <Button
            size="sm"
            variant={slowOnly ? "default" : "outline"}
            onClick={() => setSlowOnly((v) => !v)}
            data-testid="button-perf-slow-toggle"
          >
            {slowOnly ? "Showing slow only" : "Showing all"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Targets: account-mode &lt; 150ms · scanner first results &lt; 1s · trade ticket validation &lt; 750ms · {name} first text &lt; 1.5s.
            Slow rows also emit <code>perf:slow</code> in server logs.
          </span>
        </div>

        {err && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not load perf data</AlertTitle>
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Top offenders by p95</div>
          {top.length === 0 ? (
            <div className="text-xs text-muted-foreground">No actions recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 pr-3">Action</th>
                    <th className="text-right py-1 pr-3">n</th>
                    <th className="text-right py-1 pr-3">p50</th>
                    <th className="text-right py-1 pr-3">p95</th>
                    <th className="text-right py-1 pr-3">max</th>
                    <th className="text-right py-1">slow</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((r) => (
                    <tr key={r.action} className="border-t border-border/40">
                      <td className="py-1 pr-3 truncate max-w-[420px]">{r.action}</td>
                      <td className="text-right py-1 pr-3">{r.count}</td>
                      <td className="text-right py-1 pr-3">{fmtMs(r.p50Ms)}</td>
                      <td className={`text-right py-1 pr-3 ${r.p95Ms >= 1000 ? "text-warning" : ""}`}>{fmtMs(r.p95Ms)}</td>
                      <td className={`text-right py-1 pr-3 ${r.maxMs >= 2000 ? "text-danger" : ""}`}>{fmtMs(r.maxMs)}</td>
                      <td className={`text-right py-1 ${r.slowCount > 0 ? "text-warning" : "text-muted-foreground"}`}>{r.slowCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Recent {slowOnly ? "slow " : ""}actions</div>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">Nothing recorded {slowOnly ? "above the slow threshold yet" : "yet"}.</div>
          ) : (
            <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-muted-foreground sticky top-0 bg-background">
                  <tr>
                    <th className="text-left py-1 pr-3">When</th>
                    <th className="text-left py-1 pr-3">Src</th>
                    <th className="text-left py-1 pr-3">Dev</th>
                    <th className="text-left py-1 pr-3">Action</th>
                    <th className="text-right py-1 pr-3">total</th>
                    <th className="text-right py-1 pr-3">ui</th>
                    <th className="text-right py-1 pr-3">api</th>
                    <th className="text-right py-1 pr-3">render</th>
                    <th className="text-left py-1 pr-3">btnk</th>
                    <th className="text-right py-1">status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`border-t border-border/40 ${r.slow ? "text-warning" : ""}`}>
                      <td className="py-1 pr-3 text-muted-foreground">{new Date(r.recordedAt).toLocaleTimeString()}</td>
                      <td className="py-1 pr-3">{r.source === "client" ? "ui" : "api"}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{r.viewport ?? "—"}</td>
                      <td className="py-1 pr-3 truncate max-w-[380px]">{r.action}</td>
                      <td className="text-right py-1 pr-3">{fmtMs(r.totalMs)}</td>
                      <td className="text-right py-1 pr-3">{fmtMs(r.uiFeedbackMs)}</td>
                      <td className="text-right py-1 pr-3">{fmtMs(r.apiMs)}</td>
                      <td className="text-right py-1 pr-3">{fmtMs(r.frontendRenderMs)}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{r.bottleneck ?? "—"}</td>
                      <td className="text-right py-1">{r.status ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
