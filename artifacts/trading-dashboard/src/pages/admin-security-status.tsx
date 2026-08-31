import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Session = { role: string; sessionId: string; fullTesterAccess: boolean; mt5Connected: boolean; mt5Deferred: boolean; realBrokerExecutionAvailable: boolean };

// Anonymous-gate probe result. null = not yet run; status:null = the probe
// request itself failed (network) — verdict UNKNOWN, never "OK".
type AnonProbe = { status: number | null };

export default function AdminSecurityStatus() {
  const [s, setS] = useState<Session | null>(null);
  const [perms, setPerms] = useState<Record<string, unknown> | null>(null);
  const [anonProbe, setAnonProbe] = useState<AnonProbe | null>(null);

  useEffect(() => {
    // Truthy-JSON is not proof of a session: an error envelope is truthy too.
    // Only accept an ok response whose shape carries a role string.
    void fetch("/api/auth/session")
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const obj = j as { role?: unknown; error?: unknown } | null;
        setS(obj && typeof obj.role === "string" && obj.error === undefined ? (obj as Session) : null);
      })
      .catch(() => setS(null));
    void fetch("/api/auth/permissions")
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const obj = j as Record<string, unknown> | null;
        setPerms(obj && typeof obj === "object" && obj["error"] === undefined ? obj : null);
      })
      .catch(() => setPerms(null));
    // PROBED fact, not prose: hit a session-gated admin endpoint WITHOUT
    // credentials and show the actual refusal. credentials:"omit" strips the
    // session cookie so this is a genuine anonymous request.
    void fetch("/api/admin/runtime-health", { credentials: "omit" })
      .then((r) => setAnonProbe({ status: r.status }))
      .catch(() => setAnonProbe({ status: null }));
  }, []);

  const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
    <Badge className={ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}>{label}: {ok ? "OK" : "NO"}</Badge>
  );

  const anonBlocked = anonProbe?.status === 401 || anonProbe?.status === 403;

  return (
    <div className="space-y-4" data-testid="page-admin-security-status">
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

      <Card>
        <CardHeader><CardTitle>Protected mutations</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            Mutation endpoints (orders/create, risk/pause, autopilot start/stop, exports, MT5 config, kill switch)
            authorize by the validated server-side session role. The legacy <code>x-security-role</code> header is
            NOT honored — it is forbidden outside the auditable resolver and a CI guard rejects reads of it.
          </p>
          <div data-testid="anon-gate-probe">
            {anonProbe === null && <span className="text-muted-foreground">Probing the anonymous gate…</span>}
            {anonProbe !== null && anonProbe.status === null && (
              <span className="text-warning">Gate probe failed to reach the server — enforcement UNVERIFIED (not a pass).</span>
            )}
            {anonProbe !== null && anonProbe.status !== null && (
              anonBlocked
                ? <span className="text-success">Verified just now: an anonymous request to a session-gated admin endpoint was refused (HTTP {anonProbe.status}).</span>
                : <span className="text-danger">SECURITY: an anonymous request to a session-gated admin endpoint returned HTTP {anonProbe.status} — investigate immediately.</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Secret values are never sent to the browser. MT5 token (when configured) is held server-side only and redacted in audit logs.</p>
        </CardContent>
      </Card>
    </div>
  );
}
