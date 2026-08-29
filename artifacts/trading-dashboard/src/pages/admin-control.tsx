import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type ActionLog = { adminActionId: string; action: string; status: string; severity: string; reason: string | null; auditId: string | null; createdAt: string };

export default function AdminControlPage() {
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [last, setLast] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/admin-control/actions?limit=50");
    const j = await r.json();
    setActions(j.actions ?? []);
  };
  useEffect(() => { void load(); }, []);

  const run = async (path: string, label: string, body?: unknown) => {
    setBusy(label);
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      setLast(await r.json());
      await load();
    } finally { setBusy(null); }
  };

  const safe = [
    { label: "Run full health check", path: "/api/system-health/check", testid: "btn-run-health" },
    { label: "Stop autopilot", path: "/api/admin-control/stop-autopilot", testid: "btn-stop-autopilot" },
    { label: "Emergency Trading Pause", path: "/api/admin-control/emergency-watch-only", testid: "btn-watch-only" },
    { label: "Rebuild performance", path: "/api/admin-control/rebuild-performance", testid: "btn-rebuild-perf" },
    { label: "Generate coach report", path: "/api/admin-control/generate-coach-report", testid: "btn-coach-report" },
    { label: "Generate notification digest", path: "/api/admin-control/generate-notification-digest", testid: "btn-notif-digest" },
    { label: "Export health report", path: "/api/admin-control/export-health-report", testid: "btn-export-health" },
    { label: "Export audit report", path: "/api/admin-control/export-audit-report", testid: "btn-export-audit" },
  ];

  return (
    <div className="space-y-4" data-testid="page-admin-control">
      <div>
        <h1 className="text-2xl font-bold">Admin Control Center</h1>
        <p className="text-sm text-muted-foreground">Build MM — Safe controls only. Live trading is permanently DISABLED.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Safe admin actions</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {safe.map((a) => (
              <Button key={a.label} variant="outline" disabled={busy !== null} onClick={() => run(a.path, a.label)} data-testid={a.testid}>
                {busy === a.label ? "…" : a.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {last && (
        <Card>
          <CardHeader><CardTitle>Last response</CardTitle></CardHeader>
          <CardContent><pre className="text-xs max-h-72 overflow-auto whitespace-pre-wrap">{JSON.stringify(last, null, 2)}</pre></CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Recent actions</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs max-h-96 overflow-auto">
            {actions.map((a) => (
              <div key={a.adminActionId} className="flex justify-between border-b py-1" data-testid={`action-${a.action}`}>
                <span>{a.action}</span>
                <span><Badge variant={a.status === "REJECTED" ? "destructive" : "default"}>{a.status}</Badge> {a.severity} · {new Date(a.createdAt).toLocaleString()}</span>
              </div>
            ))}
            {actions.length === 0 && <em className="text-muted-foreground">no actions yet</em>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
