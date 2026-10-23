// Admin — System Handshake Monitor (Task #193, Phase 0)
//
// Read-only operator view of the ARX Handshake System's ADVISORY cross-layer
// readiness verdicts. This page never places, modifies, or blocks a trade — it
// only surfaces what the read-only coordinator observed. Wrapped in
// AdminDiagnosticsGate so non-admins (and admins previewing-as-user) see a
// clean placeholder instead of operator diagnostics.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw } from "lucide-react";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type Overall = "PASS" | "WARN" | "BLOCK" | "UNKNOWN";
type Readiness =
  | "READY"
  | "READY_WITH_WARNINGS"
  | "WAITING_FOR_DATA"
  | "STALE"
  | "DEGRADED"
  | "BLOCKED"
  | "ERROR";
type LayerStatus = "PASS" | "WARN" | "FAIL" | "SKIPPED" | "NOT_AVAILABLE";

interface LayerCheck {
  layer: string;
  status: LayerStatus;
  required: boolean;
  detail: string;
  ageMs: number | null;
}
interface Freshness {
  evaluatedAt: string;
  oldestSignalAgeMs: number | null;
  hasStaleSignal: boolean;
}
interface Permissions {
  adminOnly: boolean;
  investorScoped: boolean;
  executionCritical: boolean;
}
interface Verdict {
  type: string;
  label: string;
  overallStatus: Readiness;
  aggregateStatus: Overall;
  safeToProceed: boolean;
  implemented: boolean;
  checks: LayerCheck[];
  layersChecked: LayerCheck[];
  blockers: string[];
  warnings: string[];
  recommendations: string[];
  permissions: Permissions;
  freshness: Freshness;
  userFacingMessage: string;
  adminDetails: string;
  evaluatedAt: string;
}
interface RecentRow {
  id: number;
  handshakeType: string;
  overall: string;
  blockingReasons: string[] | null;
  warnings: string[] | null;
  implemented: boolean;
  evaluatedAt: string;
  createdAt: string;
}
interface Summary {
  total: number;
  implemented: number;
  ready: number;
  warnings: number;
  waiting: number;
  blocked: number;
  errors: number;
}
interface Resp {
  ok: boolean;
  error?: string;
  verdicts?: Verdict[];
  recent?: RecentRow[];
  summary?: Summary;
}

const OVERALL_STYLE: Record<Overall, string> = {
  PASS: "bg-success/20 text-success",
  WARN: "bg-warning/20 text-warning",
  BLOCK: "bg-danger/20 text-danger",
  UNKNOWN: "bg-muted text-muted-foreground",
};
const READINESS_STYLE: Record<Readiness, string> = {
  READY: "bg-success/20 text-success",
  READY_WITH_WARNINGS: "bg-warning/20 text-warning",
  WAITING_FOR_DATA: "bg-muted text-muted-foreground",
  STALE: "bg-warning/20 text-warning",
  DEGRADED: "bg-warning/20 text-warning",
  BLOCKED: "bg-danger/20 text-danger",
  ERROR: "bg-muted text-muted-foreground",
};
const READINESS_LABEL: Record<Readiness, string> = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready · warnings",
  WAITING_FOR_DATA: "Waiting for data",
  STALE: "Stale",
  DEGRADED: "Degraded",
  BLOCKED: "Blocked",
  ERROR: "Error",
};
const LAYER_STYLE: Record<LayerStatus, string> = {
  PASS: "bg-success/15 text-success",
  WARN: "bg-warning/15 text-warning",
  FAIL: "bg-danger/15 text-danger",
  SKIPPED: "bg-muted text-muted-foreground",
  NOT_AVAILABLE: "bg-danger/15 text-danger",
};

function HandshakeMonitorInner() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch("/api/admin/handshake-monitor", { credentials: "include" });
    if (r.status === 403) { setErr("Admin-only page."); return; }
    if (r.status === 401) { setErr("Sign in as admin to view this page."); return; }
    if (!r.ok) { setErr("Could not load the monitor. Please try again."); return; }
    setData((await r.json()) as Resp);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/handshake-monitor/refresh", { method: "POST", credentials: "include" });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (err) return <div className="p-6"><Card><CardHeader><CardTitle>{err}</CardTitle></CardHeader></Card></div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const verdicts = data.verdicts ?? [];
  const recent = data.recent ?? [];
  const summary = data.summary ?? null;

  return (
    <div className="space-y-4 p-4" data-testid="handshake-monitor">
      <div className="flex items-center gap-3">
        <Activity className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">System Handshake Monitor</h1>
          <p className="text-sm text-muted-foreground">
            Advisory cross-layer readiness. Read-only — never gates, slows, or blocks any trade.
          </p>
        </div>
        <Button onClick={() => void refresh()} disabled={busy} size="sm" data-testid="handshake-refresh">
          <RefreshCw className={`h-4 w-4 mr-1 ${busy ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {summary && (
        <div className="flex flex-wrap gap-2" data-testid="handshake-summary">
          <Badge variant="outline" className="bg-muted text-muted-foreground">
            {summary.implemented}/{summary.total} wired
          </Badge>
          <Badge variant="outline" className={OVERALL_STYLE.PASS}>{summary.ready} ready</Badge>
          <Badge variant="outline" className={OVERALL_STYLE.WARN}>{summary.warnings} warnings</Badge>
          <Badge variant="outline" className="bg-muted text-muted-foreground">{summary.waiting} waiting</Badge>
          <Badge variant="outline" className={OVERALL_STYLE.BLOCK}>{summary.blocked} blocked</Badge>
          <Badge variant="outline" className="bg-muted text-muted-foreground">{summary.errors} errors</Badge>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {verdicts.map((v) => (
          <Card key={v.type} data-testid={`handshake-card-${v.type}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">{v.label}</CardTitle>
                <Badge className={READINESS_STYLE[v.overallStatus]} data-testid={`handshake-overall-${v.type}`}>
                  {READINESS_LABEL[v.overallStatus]}
                </Badge>
              </div>
              {!v.implemented && (
                <span className="text-xs text-muted-foreground">Planned — not yet wired</span>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {v.checks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No layer checks.</p>
              ) : (
                v.checks.map((c) => (
                  <div key={c.layer} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {c.layer}
                      {c.required ? "" : " (optional)"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Badge className={LAYER_STYLE[c.status]} variant="outline">{c.status}</Badge>
                    </span>
                  </div>
                ))
              )}
              {(v.blockers.length > 0 || v.warnings.length > 0) && (
                <div className="pt-1 space-y-1">
                  {v.blockers.map((b, i) => (
                    <p key={`b${i}`} className="text-xs text-danger">{b}</p>
                  ))}
                  {v.warnings.map((w, i) => (
                    <p key={`w${i}`} className="text-xs text-warning">{w}</p>
                  ))}
                </div>
              )}
              {v.userFacingMessage && (
                <p className="pt-1 text-xs text-muted-foreground" data-testid={`handshake-msg-${v.type}`}>
                  {v.userFacingMessage}
                </p>
              )}
              {v.recommendations.length > 0 && (
                <ul className="list-disc pl-4 space-y-0.5" data-testid={`handshake-recs-${v.type}`}>
                  {v.recommendations.map((rec, i) => (
                    <li key={`r${i}`} className="text-xs text-muted-foreground">{rec}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent check-ins</CardTitle></CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No check-ins recorded yet. Use Refresh to record one.</p>
          ) : (
            <div className="space-y-1">
              {recent.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 text-xs border-b border-border/40 py-1">
                  <span className="font-mono">{row.handshakeType}</span>
                  <Badge className={OVERALL_STYLE[(row.overall as Overall)] ?? OVERALL_STYLE.UNKNOWN} variant="outline">
                    {row.overall}
                  </Badge>
                  <span className="text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminHandshakeMonitor() {
  return (
    <AdminDiagnosticsGate
      pageTitle="System Handshake Monitor"
      pageDescription="The System Handshake Monitor"
    >
      <HandshakeMonitorInner />
    </AdminDiagnosticsGate>
  );
}
