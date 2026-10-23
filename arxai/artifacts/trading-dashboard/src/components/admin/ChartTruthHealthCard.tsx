import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Activity, Check, X } from "lucide-react";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type AuditStatus = "CLEAN" | "PARTIAL" | "STALE" | "DEGRADED" | "UNAVAILABLE";

interface AuditRow {
  symbol: string;
  displaySymbol: string;
  assetClass: string;
  timeframe: string;
  candleCount: number;
  source: string | null;
  ohlcPass: boolean;
  aggregationPass: boolean;
  formingCandlePresent: boolean;
  mergePass: boolean;
  outlierSpikeCount: number;
  outlierWickCount: number;
  historicalPeriodShiftCount: number;
  mirrorPass: boolean;
  priceAlignPass: boolean;
  rubyAllowed: boolean;
  status: AuditStatus;
  rawAssessment: string;
  quality: string;
  reasons: string[];
  mockDataAdminReason: string | null;
  newestBarTime: string | null;
  latencyMs: number | null;
}

interface AuditSummary {
  total: number;
  clean: number;
  partial: number;
  stale: number;
  degraded: number;
  unavailable: number;
  worstStatus: AuditStatus;
}

interface AuditReport {
  generatedAt: string;
  cached: boolean;
  ttlSeconds: number;
  ageSeconds: number;
  nextRefreshInSeconds: number;
  probeLimit: number;
  symbols: string[];
  timeframes: string[];
  rows: AuditRow[];
  summary: AuditSummary;
}

function statusClasses(status: AuditStatus): string {
  switch (status) {
    case "CLEAN":
      return "bg-success/20 text-success";
    case "PARTIAL":
      return "bg-warning/20 text-warning";
    case "STALE":
    case "DEGRADED":
    case "UNAVAILABLE":
    default:
      return "bg-danger/20 text-danger";
  }
}

function PassCell({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="h-3.5 w-3.5 text-success inline" />
  ) : (
    <X className="h-3.5 w-3.5 text-danger inline" />
  );
}

export function ChartTruthHealthCard() {
  const { name } = useAssistantName();
  const [report, setReport] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${BASE}/api/admin/chart-truth/audit${force ? "?force=1" : ""}`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      const body = await r.json();
      if (!r.ok || !body?.ok) {
        throw new Error(body?.message ?? `Request failed (${r.status})`);
      }
      setReport(body.report as AuditReport);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load chart-truth audit");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = report?.summary ?? null;

  const grouped = useMemo(() => {
    if (!report) return [];
    const bySymbol = new Map<string, AuditRow[]>();
    for (const row of report.rows) {
      const list = bySymbol.get(row.symbol) ?? [];
      list.push(row);
      bySymbol.set(row.symbol, list);
    }
    return Array.from(bySymbol.entries());
  }, [report]);

  return (
    <Card data-testid="card-chart-truth-health">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Activity className="h-4 w-4 text-primary" />
          Chart Truth Health
          {summary && (
            <Badge className={statusClasses(summary.worstStatus)} data-testid="badge-chart-truth-worst">
              {summary.worstStatus}
            </Badge>
          )}
          <Badge variant="outline" className="font-mono text-[10px]">
            live per-timeframe QA
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => void load(false)} disabled={busy} data-testid="button-chart-truth-refresh">
            {busy ? "Probing…" : "Refresh"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load(true)} disabled={busy} data-testid="button-chart-truth-force">
            Force re-probe
          </Button>
          {report && (
            <span className="text-[11px] text-muted-foreground">
              {report.cached ? "Cached" : "Freshly probed"} · built {new Date(report.generatedAt).toLocaleTimeString()} ·
              {" "}probe limit {report.probeLimit} bars · next refresh in ~{Math.max(0, Math.round(report.nextRefreshInSeconds / 60))}m
            </span>
          )}
        </div>

        {err && (
          <Alert variant="destructive" data-testid="alert-chart-truth-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not load chart-truth audit</AlertTitle>
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        {summary && (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <Badge className="bg-success/20 text-success">CLEAN {summary.clean}</Badge>
            <Badge className="bg-warning/20 text-warning">PARTIAL {summary.partial}</Badge>
            <Badge className="bg-danger/20 text-danger">STALE {summary.stale}</Badge>
            <Badge className="bg-danger/20 text-danger">DEGRADED {summary.degraded}</Badge>
            <Badge className="bg-danger/20 text-danger">UNAVAILABLE {summary.unavailable}</Badge>
            <span className="text-muted-foreground">of {summary.total} probes</span>
          </div>
        )}

        {report && (
          <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-muted-foreground sticky top-0 bg-background">
                <tr>
                  <th className="text-left py-1 pr-3">Symbol</th>
                  <th className="text-left py-1 pr-3">TF</th>
                  <th className="text-left py-1 pr-3">Status</th>
                  <th className="text-right py-1 pr-3">Count</th>
                  <th className="text-left py-1 pr-3">Source</th>
                  <th className="text-center py-1 pr-2">OHLC</th>
                  <th className="text-center py-1 pr-2">Aggr</th>
                  <th className="text-center py-1 pr-2">Form</th>
                  <th className="text-center py-1 pr-2">Merge</th>
                  <th className="text-center py-1 pr-2">Mirror</th>
                  <th className="text-center py-1 pr-2">Price</th>
                  <th className="text-center py-1 pr-2">{name}</th>
                  <th className="text-left py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(([symbol, rows]) =>
                  rows.map((row, i) => (
                    <tr key={`${symbol}-${row.timeframe}`} className="border-t border-border/40 align-top" data-testid={`chart-truth-row-${symbol}-${row.timeframe}`}>
                      <td className="py-1 pr-3">{i === 0 ? `${row.displaySymbol}` : ""}</td>
                      <td className="py-1 pr-3">{row.timeframe}</td>
                      <td className="py-1 pr-3">
                        <Badge className={statusClasses(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="text-right py-1 pr-3">{row.candleCount}</td>
                      <td className="py-1 pr-3 truncate max-w-[160px]" title={row.source ?? ""}>{row.source ?? "—"}</td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.ohlcPass} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.aggregationPass} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.formingCandlePresent} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.mergePass} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.mirrorPass} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.priceAlignPass} /></td>
                      <td className="text-center py-1 pr-2"><PassCell ok={row.rubyAllowed} /></td>
                      <td className="py-1 text-muted-foreground max-w-[280px] whitespace-normal break-words">
                        {row.reasons.length > 0 ? row.reasons.join(" ") : "—"}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Lightweight {report?.probeLimit ?? 10}-bar probe per symbol × timeframe through the live market-data router
          and candle truth engine. Cached for {report ? Math.round(report.ttlSeconds / 60) : 5} minutes so it never hits a
          provider more often than a normal chart load. History-minimum is intentionally not enforced here (small probe),
          so a green row means real data is flowing, valid, and fresh.
        </p>
      </CardContent>
    </Card>
  );
}
