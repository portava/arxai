import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Subsys = { status: string; notes: string[]; metrics?: Record<string, unknown>; paperOnly?: boolean; liveTradingAllowed?: boolean };
type Report = {
  health_check_id: string; generated_at: string;
  overallStatus: "HEALTHY"|"DEGRADED"|"UNSAFE"|"FAILED";
  liveTradingStatus: "DISABLED"; mode: "PAPER_ONLY";
  subsystemStatus: Record<string, Subsys>;
  databaseStatus: { connected: boolean; missingTables: string[]; rowCounts: Record<string, number> };
  endpointStatus: { totalChecked: number; passed: number; failed: number; degraded: number; results: Array<{ path: string; status: number|null; ok: boolean; latencyMs: number }> };
  safetyStatus: { hardBlocks: Array<{ code: string; severity: string; message: string }>; warnings: string[] };
  secretSafetyStatus: { secretsDetectedInFrontend: number; secretsDetectedInLogs: number; redactionWorking: boolean };
  performanceStatus: { failedJobs: number; errorRate: number; latestNotificationCriticalCount: number };
  recommendedAdminActions: string[]; warnings: string[]; errors: string[];
};

const tone = (s: string): "default"|"secondary"|"destructive"|"outline" => {
  if (s === "HEALTHY" || s === "OK") return "default";
  if (s === "DEGRADED") return "secondary";
  if (s === "UNAVAILABLE") return "outline";
  return "destructive";
};

export default function SystemHealthPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/system-health/check", { method: "POST" });
      const j = await r.json();
      setReport(j.report ?? null);
    } catch (e) { setErr(String(e)); } finally { setLoading(false); }
  };
  useEffect(() => { void run(); }, []);

  const banner = report && (report.overallStatus !== "HEALTHY" || report.safetyStatus.hardBlocks.length > 0);

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6" data-testid="page-system-health">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">System Health</h1>
          <p className="text-sm text-muted-foreground">Build MM — Diagnostics, audit & admin (PAPER_ONLY, live trading DISABLED)</p>
        </div>
        <Button onClick={run} disabled={loading} data-testid="btn-run-health-check">{loading ? "Running…" : "Run health check"}</Button>
      </div>

      {banner && (
        <Card className="border-destructive">
          <CardContent className="py-3 text-sm">
            <strong>Safety attention:</strong> {report?.safetyStatus.hardBlocks.length ? "Active hard safety locks detected." : `Overall status: ${report?.overallStatus}.`}
          </CardContent>
        </Card>
      )}

      {err && <div className="text-destructive text-sm">{err}</div>}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card><CardHeader><CardTitle className="text-xs">Overall</CardTitle></CardHeader><CardContent><Badge variant={tone(report.overallStatus)}>{report.overallStatus}</Badge></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-xs">Live trading</CardTitle></CardHeader><CardContent><Badge variant="outline">{report.liveTradingStatus}</Badge></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-xs">Mode</CardTitle></CardHeader><CardContent><Badge>{report.mode}</Badge></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-xs">Critical unread</CardTitle></CardHeader><CardContent>{report.performanceStatus.latestNotificationCriticalCount}</CardContent></Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Subsystems (AA–LL)</CardTitle></CardHeader>
            <CardContent>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(report.subsystemStatus).map(([k, v]) => (
                  <div key={k} className="rounded border p-3" data-testid={`subsystem-${k}`}>
                    <div className="flex items-center justify-between mb-1">
                      <strong>{k}</strong>
                      <Badge variant={tone(v.status)}>{v.status}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">{v.notes.join(" · ")}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Database</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <div>Connected: {String(report.databaseStatus.connected)}</div>
                <div>Missing tables: {report.databaseStatus.missingTables.length === 0 ? "none" : report.databaseStatus.missingTables.join(", ")}</div>
                <div>Row counts: <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(report.databaseStatus.rowCounts, null, 2)}</pre></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Endpoints</CardTitle></CardHeader>
              <CardContent className="text-sm">
                <div>Checked: {report.endpointStatus.totalChecked} · Passed: {report.endpointStatus.passed} · Failed: {report.endpointStatus.failed} · Degraded: {report.endpointStatus.degraded}</div>
                <div className="mt-2 max-h-48 overflow-auto text-xs">
                  {report.endpointStatus.results.map((r) => (
                    <div key={r.path} className="flex justify-between border-b py-0.5"><span>{r.path}</span><span>{r.status ?? "ERR"} · {r.latencyMs}ms</span></div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Safety</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <div>Hard blocks: {report.safetyStatus.hardBlocks.length === 0 ? "none" : report.safetyStatus.hardBlocks.map((h) => h.code).join(", ")}</div>
                <div>Warnings: {report.safetyStatus.warnings.length === 0 ? "none" : report.safetyStatus.warnings.join("; ")}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Secret redaction</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <div>Frontend leaks: {report.secretSafetyStatus.secretsDetectedInFrontend}</div>
                <div>Log leaks: {report.secretSafetyStatus.secretsDetectedInLogs}</div>
                <div>Working: {String(report.secretSafetyStatus.redactionWorking)}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Recommended admin actions</CardTitle></CardHeader>
            <CardContent>
              {report.recommendedAdminActions.length === 0
                ? <em className="text-muted-foreground">none</em>
                : <ul className="list-disc pl-5 text-sm">{report.recommendedAdminActions.map((a, i) => <li key={i}>{a}</li>)}</ul>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
