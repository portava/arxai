import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Layers } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

// Mirrors the server CandleDepthReport contract (read-only diagnostics).
interface DepthRow {
  label: string;
  timeframe: string;
  depthTargetDays: number;
  source: string | null;
  status: "live" | "stale" | "historical_only" | "unavailable";
  requested: number;
  returned: number;
  oldest: string | null;
  newest: string | null;
  coverageDays: number | null;
  depthTargetMet: boolean;
  candleAgeMs: number | null;
  hasMoreHistory: boolean;
  providerLimitReached: boolean;
  providerMessage: string | null;
  cacheCount: number;
  historyDepthSupport: string;
  executionSource: string;
  pass: boolean;
  note: string;
}
interface DepthReport {
  generatedAt: string;
  symbol: string;
  assetClass: string;
  liveQuoteSource: string;
  executionSource: string;
  brokerSymbol: string;
  brokerSymbolMapped: boolean;
  brokerDirectoryLoaded: boolean;
  brokerDirectoryEntryCount: number;
  liveQuote: { present: boolean; fresh: boolean; hasPrice: boolean; ageMs: number | null };
  rows: DepthRow[];
  summary: { total: number; passed: number; failed: number; depthTargetsMet: number };
}

function fmtAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtOldest(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function statusClass(status: DepthRow["status"]): string {
  switch (status) {
    case "live": return "bg-success/20 text-success";
    case "stale": return "bg-warning/20 text-warning";
    case "historical_only": return "bg-primary/20 text-primary";
    default: return "bg-muted text-muted-foreground";
  }
}

export function CandleDepthDiagnosticsCard() {
  const [symbol, setSymbol] = useState("EURUSD");
  const [report, setReport] = useState<DepthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    const s = symbol.trim();
    if (!s) { setErr("Enter a symbol first."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BASE}/api/admin/market-data/candle-depth?symbol=${encodeURIComponent(s)}`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      const body = await r.json();
      if (!r.ok || !body?.ok) {
        setErr(body?.message ?? body?.error ?? `Request failed (${r.status})`);
        setReport(null);
        return;
      }
      setReport(body.report as DepthReport);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to run candle-depth test");
      setReport(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="card-candle-depth">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" /> Candle Depth Diagnostics
          <Badge variant="outline" className="ml-2 font-mono text-[10px]">read-only</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
            placeholder="Symbol (e.g. EURUSD, V75, NAS100)"
            className="w-64 font-mono"
            data-testid="input-candle-depth-symbol"
          />
          <Button onClick={() => void run()} disabled={busy} data-testid="button-candle-depth-run">
            {busy ? "Testing…" : "Test Candle Depth"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Probes 1m/5m/15m/1h/4h/1D through the real history path. Status is verbatim —
            historical/stale is never relabeled live.
          </span>
        </div>

        {err && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not run candle-depth test</AlertTitle>
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        {report && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div><span className="text-muted-foreground">Symbol:</span> <span className="font-mono">{report.symbol}</span></div>
              <div><span className="text-muted-foreground">Asset class:</span> <span className="font-mono">{report.assetClass}</span></div>
              <div className="col-span-2">
                <span className="text-muted-foreground">Passed:</span>{" "}
                <span className={report.summary.failed === 0 ? "text-success" : "text-warning"}>
                  {report.summary.passed}/{report.summary.total}
                </span>
                <span className="text-muted-foreground"> · depth targets met {report.summary.depthTargetsMet}/{report.summary.total}</span>
              </div>
              <div className="col-span-2 sm:col-span-4 text-[11px] text-muted-foreground">
                <span className="font-medium">Execution mapping (descriptive):</span> {report.executionSource}
              </div>
              <div className="col-span-2 sm:col-span-4 text-[11px] text-muted-foreground">
                <span className="font-medium">Broker symbol:</span>{" "}
                <span className="font-mono">{report.brokerSymbol}</span>{" "}
                {report.brokerSymbolMapped ? "(mapped)" : "(verbatim)"} ·{" "}
                specs {report.brokerDirectoryLoaded ? `loaded (${report.brokerDirectoryEntryCount})` : "missing"} ·{" "}
                live quote {report.liveQuote.present
                  ? `${report.liveQuote.fresh ? "fresh" : "stale"} (age ${fmtAge(report.liveQuote.ageMs)})`
                  : "absent"}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 pr-3">TF</th>
                    <th className="text-left py-1 pr-3">Result</th>
                    <th className="text-left py-1 pr-3">Status</th>
                    <th className="text-left py-1 pr-3">Source</th>
                    <th className="text-right py-1 pr-3">req/ret</th>
                    <th className="text-left py-1 pr-3">Oldest candle</th>
                    <th className="text-left py-1 pr-3">Newest candle</th>
                    <th className="text-right py-1 pr-3">Depth</th>
                    <th className="text-right py-1 pr-3">Age</th>
                    <th className="text-right py-1 pr-3">Cache</th>
                    <th className="text-left py-1 pr-3">More</th>
                    <th className="text-left py-1 pr-3">Exec</th>
                    <th className="text-left py-1">Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.timeframe} className="border-t border-border/40" data-testid={`depth-row-${row.timeframe}`}>
                      <td className="py-1 pr-3">{row.label}</td>
                      <td className="py-1 pr-3">
                        <Badge className={row.pass ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}>
                          {row.pass ? "PASS" : "FAIL"}
                        </Badge>
                      </td>
                      <td className="py-1 pr-3"><Badge className={statusClass(row.status)}>{row.status}</Badge></td>
                      <td className="py-1 pr-3 truncate max-w-[160px]">{row.source ?? "—"}</td>
                      <td className="text-right py-1 pr-3">{row.requested}/{row.returned}</td>
                      <td className="py-1 pr-3">{fmtOldest(row.oldest)}</td>
                      <td className="py-1 pr-3">{fmtOldest(row.newest)}</td>
                      <td className={`text-right py-1 pr-3 ${row.depthTargetMet ? "text-success" : ""}`}>
                        {row.coverageDays != null ? `${row.coverageDays.toFixed(0)}` : "—"}/{row.depthTargetDays}d
                      </td>
                      <td className="text-right py-1 pr-3">{fmtAge(row.candleAgeMs)}</td>
                      <td className="text-right py-1 pr-3">{row.cacheCount}</td>
                      <td className="py-1 pr-3 text-muted-foreground">
                        {row.hasMoreHistory ? "yes" : row.providerLimitReached ? "limit" : "no"}
                      </td>
                      <td className="py-1 pr-3 truncate max-w-[140px] text-muted-foreground" title={row.executionSource}>
                        {row.executionSource}
                      </td>
                      <td className={`py-1 truncate max-w-[200px] ${row.providerMessage ? "text-warning" : "text-muted-foreground"}`} title={row.providerMessage ?? ""}>
                        {row.providerMessage ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-1">
              {report.rows.filter((r) => r.providerMessage || !r.pass).map((r) => (
                <p key={r.timeframe} className="text-[11px] text-muted-foreground">
                  <span className="font-medium">{r.label}:</span> {r.note}
                </p>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
