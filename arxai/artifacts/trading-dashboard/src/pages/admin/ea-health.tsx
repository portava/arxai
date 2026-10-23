// Task #33 — /admin/ea-health
//
// OPERATOR-ONLY EA Health dashboard. Consolidates existing reliability signals
// (capabilities, heartbeat freshness, EA inputs, clock drift, command-poll age,
// last command result, self-update support, update status) from the read-only
// /api/admin/ea/health aggregator. NO new feature, NO new trading path.
//
// SECURITY: wrapped in AdminDiagnosticsGate (also blocks admin-previewing-as-user).
// The server independently requires an ADMIN/OWNER session and emits ONLY the
// allowlist connection projection — no raw token / apiKeyHash ever reaches here.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";
import {
  RefreshCw, CheckCircle2, XCircle, AlertTriangle, Wifi, WifiOff, Clock, HelpCircle,
} from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
async function apiJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { credentials: "include" });
  return (await r.json()) as T;
}

type FeatureStatus = "SUPPORTED" | "UNSUPPORTED_ADMIN_WARNING";
type EaInputs = {
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;
  terminalConnected: boolean | null;
  algoTradingAllowed: boolean | null;
};
type HealthRow = {
  connection: {
    id: number; userId: number | null; connectionName: string | null;
    status: string | null; accountType: string | null; broker: string | null;
    server: string | null; eaVersion: string | null; tokenLast4: string | null;
    lastHeartbeatAt: string | null; heartbeatAgeSeconds: number | null;
  };
  liveness: "fresh" | "stale" | "offline" | "revoked";
  conditions: string[];
  heartbeatAgeSeconds: number | null;
  accountType: string | null;
  eaVersion: string | null;
  capabilitiesReportedAt: string | null;
  featureSupport: Record<string, FeatureStatus>;
  eaInputs: EaInputs;
  allowOrderExecution: boolean;
  liveLocked: boolean;
  clockDrift: { seconds: number | null; severity: string | null };
  lastCommand: null | {
    commandId: string; commandType: string; status: string; symbol: string;
    side: string; mt5Retcode: number | null; rejectionReason: string | null;
    pickedByEaAt: string | null; resultRecordedAt: string | null; createdAt: string | null;
  };
  commandPollAgeSeconds: number | null;
  lastReconciliationResult: {
    issueCount: number;
    criticalCount: number;
    types: string[];
    latest: { type: string; severity: string; reason: string; recommendedAction: string } | null;
    computedAt: string;
  };
  selfUpdateSupported: boolean;
  update: {
    currentVersion: string | null; latestApprovedVersion: string | null;
    updateAvailable: boolean; decision: string; reason: string | null;
    manualBootstrapRequired: boolean;
  };
  lastUpdateReport: null | {
    phase: string; outcome: string; fromVersion: string | null; toVersion: string | null;
    checksumVerified: boolean; blockReason: string | null; reportedAt: string | null;
  };
};
type HealthResp = {
  ok: boolean;
  evaluatedAt: string;
  counts: { total: number; fresh: number; stale: number; offline: number };
  rows: HealthRow[];
};

function Tri({ v }: { v: boolean | null }) {
  if (v === null) return <span className="inline-flex items-center gap-1 text-txt-muted"><HelpCircle className="w-3.5 h-3.5" /> unknown</span>;
  return v
    ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> yes</span>
    : <span className="inline-flex items-center gap-1 text-txt-secondary"><XCircle className="w-3.5 h-3.5" /> no</span>;
}

function livenessBadge(l: HealthRow["liveness"]) {
  const map: Record<string, string> = {
    fresh: "border-success/40 text-success",
    stale: "border-warning/40 text-warning",
    offline: "border-danger/40 text-danger",
    revoked: "border-border text-txt-secondary",
  };
  return <Badge variant="outline" className={map[l]}>{l.toUpperCase()}</Badge>;
}

function EaHealthInner() {
  const [data, setData] = useState<HealthResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      const r = await apiJson<HealthResp>("/api/admin/ea/health");
      if (!r.ok) throw new Error("Failed to load EA health");
      setData(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load EA health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10000);
    return () => clearInterval(id);
  }, []);

  const featureKeys = useMemo(() => {
    const set = new Set<string>();
    data?.rows.forEach((r) => Object.keys(r.featureSupport).forEach((k) => set.add(k)));
    return Array.from(set).sort();
  }, [data]);

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4" data-testid="admin-ea-health">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Wifi className="w-5 h-5 text-success" /> EA Health
          </h1>
          <p className="text-sm text-txt-secondary">Operator-only view of every MT5 bridge's capabilities, heartbeat, and update state. Read-only — does not change execution state.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} data-testid="ea-health-refresh">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {data && (
        <div className="flex gap-2 flex-wrap text-sm">
          <Badge variant="outline">Total: {data.counts.total}</Badge>
          <Badge variant="outline" className="border-success/40 text-success">Fresh: {data.counts.fresh}</Badge>
          <Badge variant="outline" className="border-warning/40 text-warning">Stale: {data.counts.stale}</Badge>
          <Badge variant="outline" className="border-danger/40 text-danger">Offline: {data.counts.offline}</Badge>
        </div>
      )}

      {loading && !data && <Card><CardContent className="p-6 text-sm text-txt-secondary">Loading EA health…</CardContent></Card>}
      {error && <Card><CardContent className="p-6 text-sm text-danger">{error}</CardContent></Card>}
      {data && data.rows.length === 0 && (
        <Card><CardContent className="p-6 text-sm text-txt-secondary">No active MT5 bridges reporting.</CardContent></Card>
      )}

      {data?.rows.map((row) => (
        <Card key={row.connection.id} data-testid={`ea-health-row-${row.connection.id}`}>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {row.liveness === "fresh" ? <Wifi className="w-4 h-4 text-success" /> : <WifiOff className="w-4 h-4 text-txt-secondary" />}
                  {row.connection.connectionName ?? `Connection ${row.connection.id}`}
                  <span className="text-xs text-txt-muted">user #{row.connection.userId ?? "—"}</span>
                </CardTitle>
                <CardDescription>
                  {row.connection.broker ?? "broker —"} · {row.connection.server ?? "server —"} · token …{row.connection.tokenLast4 ?? "----"}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {livenessBadge(row.liveness)}
                <Badge variant="outline">EA v{row.eaVersion ?? "?"}</Badge>
                <Badge variant="outline" className={row.accountType === "live" || row.accountType === "real" ? "border-danger/40 text-danger" : ""}>{(row.accountType ?? "unknown").toUpperCase()}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Heartbeat & connection</div>
                <div className="flex justify-between"><span className="text-txt-secondary">Heartbeat age</span><span className={(row.heartbeatAgeSeconds ?? 999) > 15 ? "text-warning" : ""}>{row.heartbeatAgeSeconds === null ? "—" : `${row.heartbeatAgeSeconds}s`}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Last heartbeat</span><span>{row.connection.lastHeartbeatAt ? new Date(row.connection.lastHeartbeatAt).toLocaleString() : "never"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Terminal connected</span><Tri v={row.eaInputs.terminalConnected} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Command-poll age</span><span>{row.commandPollAgeSeconds === null ? "—" : `${row.commandPollAgeSeconds}s`}</span></div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">EA inputs & safety</div>
                <div className="flex justify-between"><span className="text-txt-secondary">AlgoTrading allowed</span><Tri v={row.eaInputs.algoTradingAllowed} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">EnableLiveExecution</span><Tri v={row.eaInputs.enableLiveExecution} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">ReadOnlyMode</span><Tri v={row.eaInputs.readOnlyMode} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">allowOrderExecution</span><Tri v={row.allowOrderExecution} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">liveLocked</span><Tri v={row.liveLocked} /></div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Clock drift & updates</div>
                <div className="flex justify-between">
                  <span className="text-txt-secondary inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Clock drift</span>
                  <span className={row.clockDrift.severity === "SEVERE" ? "text-danger" : row.clockDrift.severity === "WARN" ? "text-warning" : ""}>
                    {row.clockDrift.seconds === null ? "—" : `${row.clockDrift.seconds.toFixed(1)}s`} {row.clockDrift.severity ? `(${row.clockDrift.severity})` : ""}
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-txt-secondary">Self-update supported</span><Tri v={row.selfUpdateSupported} /></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Latest approved</span><span>{row.update.latestApprovedVersion ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-txt-secondary">Update available</span><Tri v={row.update.updateAvailable} /></div>
                {row.update.manualBootstrapRequired && (
                  <div className="text-warning inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Manual bootstrap EA install required</div>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs uppercase tracking-wider text-txt-secondary">Capability map</div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                {featureKeys.map((k) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-txt-secondary">{k.replace(/^supports/, "")}</span>
                    {row.featureSupport[k] === "SUPPORTED"
                      ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> supported</span>
                      : <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="w-3.5 h-3.5" /> unsupported</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Last command result</div>
                {row.lastCommand ? (
                  <div className="rounded-md border border-border bg-card p-2 space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-txt-secondary">{row.lastCommand.commandType} {row.lastCommand.symbol} {row.lastCommand.side}</span><Badge variant="outline">{row.lastCommand.status}</Badge></div>
                    <div className="flex justify-between"><span className="text-txt-secondary">Retcode</span><span>{row.lastCommand.mt5Retcode ?? "—"}</span></div>
                    {row.lastCommand.rejectionReason && <div className="text-warning">{row.lastCommand.rejectionReason}</div>}
                    <div className="text-txt-muted">{row.lastCommand.resultRecordedAt ? new Date(row.lastCommand.resultRecordedAt).toLocaleString() : row.lastCommand.createdAt ? new Date(row.lastCommand.createdAt).toLocaleString() : "—"}</div>
                  </div>
                ) : <div className="text-txt-muted text-xs">No live commands for this user.</div>}
              </div>

              <div className="space-y-1.5">
                <div className="text-xs uppercase tracking-wider text-txt-secondary">Last update report</div>
                {row.lastUpdateReport ? (
                  <div className="rounded-md border border-border bg-card p-2 space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-txt-secondary">{row.lastUpdateReport.phase}</span><Badge variant="outline" className={row.lastUpdateReport.outcome === "OK" ? "border-success/40 text-success" : row.lastUpdateReport.outcome === "FAILED" ? "border-danger/40 text-danger" : "border-warning/40 text-warning"}>{row.lastUpdateReport.outcome}</Badge></div>
                    <div className="flex justify-between"><span className="text-txt-secondary">{row.lastUpdateReport.fromVersion ?? "?"} → {row.lastUpdateReport.toVersion ?? "?"}</span><span>checksum {row.lastUpdateReport.checksumVerified ? "ok" : "no"}</span></div>
                    {row.lastUpdateReport.blockReason && <div className="text-warning">{row.lastUpdateReport.blockReason}</div>}
                    <div className="text-txt-muted">{row.lastUpdateReport.reportedAt ? new Date(row.lastUpdateReport.reportedAt).toLocaleString() : "—"}</div>
                  </div>
                ) : <div className="text-txt-muted text-xs">No self-update reports for this user.</div>}
              </div>
            </div>

            <div className="mt-4 space-y-1.5">
              <div className="text-xs uppercase tracking-wider text-txt-secondary">Last reconciliation result</div>
              {row.lastReconciliationResult.issueCount === 0 ? (
                <div className="rounded-md border border-success/30 bg-success/5 p-2 text-xs text-success" data-testid={`recon-clean-${row.connection.id}`}>
                  No open reconciliation issues for this bridge.
                  <span className="text-txt-muted"> · checked {new Date(row.lastReconciliationResult.computedAt).toLocaleString()}</span>
                </div>
              ) : (
                <div className="rounded-md border border-warning/40 bg-warning/5 p-2 space-y-1 text-xs" data-testid={`recon-issues-${row.connection.id}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={row.lastReconciliationResult.criticalCount > 0 ? "border-danger/40 text-danger" : "border-warning/40 text-warning"}>
                      {row.lastReconciliationResult.issueCount} open
                    </Badge>
                    {row.lastReconciliationResult.criticalCount > 0 && (
                      <Badge variant="outline" className="border-danger/40 text-danger">{row.lastReconciliationResult.criticalCount} critical</Badge>
                    )}
                    {row.lastReconciliationResult.types.map((t) => (
                      <span key={t} className="text-txt-secondary">{t}</span>
                    ))}
                  </div>
                  {row.lastReconciliationResult.latest && (
                    <>
                      <div className="text-txt-secondary">{row.lastReconciliationResult.latest.reason}</div>
                      <div className="text-txt-muted">{row.lastReconciliationResult.latest.recommendedAction}</div>
                    </>
                  )}
                  <div className="text-txt-muted">checked {new Date(row.lastReconciliationResult.computedAt).toLocaleString()}</div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdminEaHealthPage() {
  return (
    <AdminDiagnosticsGate pageTitle="EA Health" pageDescription="EA Health">
      <EaHealthInner />
    </AdminDiagnosticsGate>
  );
}
