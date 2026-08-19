import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Session = { role: string; sessionId: string; fullTesterAccess: boolean; mt5Connected: boolean; mt5Deferred: boolean; realBrokerExecutionAvailable: boolean };
type FH = { safety: Record<string, boolean>; finalState: Record<string, boolean> };

export default function AdminSecurityStatus() {
  const [s, setS] = useState<Session | null>(null);
  const [fh, setFh] = useState<FH | null>(null);
  const [perms, setPerms] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void fetch("/api/auth/session").then((r) => r.json()).then(setS);
    void fetch("/api/auth/permissions").then((r) => r.json()).then(setPerms);
    void fetch("/api/system/full-health", { headers: { "x-security-role": "ADMIN" } }).then((r) => r.json()).then(setFh);
  }, []);

  const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
    <Badge className={ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}>{label}: {ok ? "OK" : "NO"}</Badge>
  );

  return (
    <div className="space-y-4 p-4" data-testid="page-admin-security-status">
      <div>
        <h1 className="text-2xl font-bold">Security Status</h1>
        <p className="text-sm text-muted-foreground">Live view of auth, permissions, audit, and broker-execution lock.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Auth</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <Pill ok={!!s} label="Session" />
            <Pill ok={!!perms} label="Permission matrix" />
            <Pill ok={!!s?.fullTesterAccess} label="Full tester access" />
          </div>
          {s && <pre className="text-xs">{JSON.stringify(s, null, 2)}</pre>}
        </CardContent>
      </Card>

      {fh && (
        <Card>
          <CardHeader><CardTitle>Hardening</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Pill ok={!!fh.safety?.killSwitchUiPresent} label="Kill switch UI" />
            <Pill ok={!!fh.safety?.riskGovernorActive} label="Risk Governor" />
            <Pill ok={!!fh.safety?.auditLoggingActive} label="Audit logging" />
            <Pill ok={!!fh.safety?.mt5HonestyOk} label="MT5 honesty" />
            <Pill ok={!!fh.safety?.noFakeBrokerExecution} label="No fake fills" />
            <Pill ok={!fh.finalState?.LIVE_CHART_ACTIVE ? false : true} label="Live chart" />
            <Pill ok={!!fh.finalState?.SIMULATOR_READY} label="Simulator" />
            <Pill ok={!!fh.finalState?.LIVE_TESTER_WORKFLOWS_OPEN} label="Tester workflows" />
            <Pill ok={!!fh.finalState?.REAL_BROKER_EXECUTION_LOCKED_UNTIL_MT5} label="Broker execution locked" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Protected mutations</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <p>Mutation endpoints (orders/create, risk/pause, autopilot start/stop, exports, MT5 config, kill switch) require <code>x-security-role: ADMIN</code> or the equivalent signed session cookie.</p>
          <p className="text-xs text-muted-foreground">Secret values are never sent to the browser. MT5 token (when configured) is held server-side only and redacted in audit logs.</p>
        </CardContent>
      </Card>
    </div>
  );
}
