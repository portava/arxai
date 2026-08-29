import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { safeDate } from "@/lib/safeFormat";
import { Badge } from "@/components/ui/badge";
import { Bell, Check, X, Clock } from "lucide-react";

type Alert = {
  alertId: string; severity: string;
  symbol?: string; timeframe?: string;
  message: string; reason: string; recommendedAction: string;
  source: string; createdAt: string;
  acknowledgedAt?: string | null;
};

const SEV: Record<string, string> = {
  info: "bg-primary/20 text-primary border-primary/40",
  warning: "bg-warning/20 text-warning border-warning/40",
  critical: "bg-danger/20 text-danger border-danger/40",
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  return r.json();
}

export default function AlertsCenter() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    const r = await fetch(`/api/alerts/scanner?limit=100${showAll ? "" : "&unackedOnly=true"}`).then((x) => x.json());
    setAlerts(r.alerts ?? []);
  }
  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [showAll]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Bell className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Alerts Center</h1>
          <p className="text-sm text-muted-foreground">Hot setups, risk warnings, MT5 deferred notices. Simulator only.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        <Badge>{alerts.length}</Badge>
        <Button size="sm" variant="outline" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show open only" : "Show all"}
        </Button>
      </div>

      {alerts.length === 0
        ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No alerts yet — start the scanner to generate hot-setup alerts.</CardContent></Card>
        : <div className="space-y-2">
            {alerts.map((a) => (
              <Card key={a.alertId} className={a.acknowledgedAt ? "opacity-60" : ""}>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={SEV[a.severity] ?? ""}>{a.severity}</Badge>
                    <Badge variant="outline">{a.source}</Badge>
                    {a.symbol && <Badge variant="outline">{a.symbol} {a.timeframe ?? ""}</Badge>}
                    <CardTitle className="text-sm flex-1">{a.message}</CardTitle>
                    <span className="text-xs text-muted-foreground">{safeDate(a.createdAt, "time")}</span>
                  </div>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                  <p className="text-muted-foreground">{a.reason}</p>
                  <p>Recommended: <span className="font-medium">{a.recommendedAction}</span></p>
                  {!a.acknowledgedAt && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="h-7" onClick={async () => { await api("/api/alerts/acknowledge", { method: "POST", body: JSON.stringify({ alertId: a.alertId }) }); load(); }}>
                        <Check className="h-3 w-3 mr-1" /> Acknowledge
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" onClick={async () => { await api("/api/alerts/snooze", { method: "POST", body: JSON.stringify({ alertId: a.alertId, minutes: 10 }) }); load(); }}>
                        <Clock className="h-3 w-3 mr-1" /> Snooze 10m
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" onClick={async () => { await api("/api/alerts/dismiss", { method: "POST", body: JSON.stringify({ alertId: a.alertId }) }); load(); }}>
                        <X className="h-3 w-3 mr-1" /> Dismiss
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>}
    </div>
  );
}
