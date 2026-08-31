import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Activity, AlertTriangle, HeartPulse } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

interface RuntimeHealth {
  ok: boolean;
  checkedAt: string;
  apiServer: {
    listening: boolean;
    pid: number;
    version: string;
    buildTimestamp: string | null;
    startedAt: string;
    uptimeSeconds: number;
  };
  database: { ok: boolean; latencyMs: number | null };
  bridge: {
    /** false = the server's aggregate query FAILED — counts are not valid.
     * Absent (older server) = treated as valid for compatibility. */
    ok?: boolean;
    total: number;
    healthy: number;
    stale: number;
    down: number;
    latestHeartbeatAgeSeconds: number | null;
  };
  notes: string[];
}

function fmtUptime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function WorkflowHealthCard() {
  const [data, setData] = useState<RuntimeHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${BASE}/api/admin/runtime-health`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      if (r.status === 403) {
        setErr("Runtime health is available to operators only.");
        setData(null);
        return;
      }
      if (!r.ok) {
        setErr(`Runtime health unavailable (status ${r.status}).`);
        setData(null);
        return;
      }
      setData((await r.json()) as RuntimeHealth);
    } catch {
      setErr("Could not reach the api-server runtime-health endpoint.");
      setData(null);
    } finally {
      setBusy(false);
    }
  }

  // Pull once on mount; refresh is manual. No aggressive polling — this is an
  // operator diagnostic, and the global QueryClient/visibility rules already
  // discourage background loops.
  useEffect(() => {
    void load();
  }, []);

  return (
    <Card data-testid="card-workflow-health">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-success" />
          Workflow Health
          <Badge variant="outline">Admin</Badge>
          {data && (
            <Badge
              className={
                data.ok
                  ? "bg-success/20 text-success"
                  : "bg-danger/20 text-danger"
              }
              data-testid="badge-workflow-health"
            >
              {data.ok ? "Healthy" : "Degraded"}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => void load()}
            disabled={busy}
            data-testid="button-workflow-health-refresh"
          >
            {busy ? "Loading…" : "Refresh"}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {err && (
          <Alert variant="default" className="border-warning/40 bg-warning/5">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle>Unavailable</AlertTitle>
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-ruby" />
                <span className="text-muted-foreground">api-server:</span>{" "}
                <span className="text-success">listening</span>
                <span className="text-muted-foreground">· up {fmtUptime(data.apiServer.uptimeSeconds)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">DB:</span>{" "}
                <span className={data.database.ok ? "text-success" : "text-danger"}>
                  {data.database.ok ? "reachable" : "DOWN"}
                </span>
                {data.database.latencyMs != null && (
                  <span className="text-muted-foreground"> · {data.database.latencyMs}ms</span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Version:</span>{" "}
                <span className="font-mono">{data.apiServer.version}</span>
              </div>
              <div>
                <span className="text-muted-foreground">PID:</span>{" "}
                <span className="font-mono">{data.apiServer.pid}</span>
              </div>
            </div>

            <div className="text-xs">
              <div className="text-muted-foreground mb-1">MT5 / EA bridges (aggregate heartbeat)</div>
              {data.bridge.ok === false ? (
                // A failed aggregate query must not masquerade as "no bridges".
                <div className="text-warning font-mono" data-testid="workflow-health-bridge">
                  unavailable — the bridge heartbeat query failed; counts are unknown, not zero
                </div>
              ) : (
              <div className="flex gap-3 font-mono" data-testid="workflow-health-bridge">
                <span>total {data.bridge.total}</span>
                <span className="text-success">healthy {data.bridge.healthy}</span>
                <span className="text-warning">stale {data.bridge.stale}</span>
                <span className="text-danger">down {data.bridge.down}</span>
                <span className="text-muted-foreground">
                  latest{" "}
                  {data.bridge.latestHeartbeatAgeSeconds == null
                    ? "—"
                    : `${data.bridge.latestHeartbeatAgeSeconds}s ago`}
                </span>
              </div>
              )}
            </div>

            <div className="text-[11px] text-muted-foreground space-y-1">
              <p>Last checked: {new Date(data.checkedAt).toLocaleTimeString()}</p>
              {data.notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
              <p className="font-mono">
                Frontend listening, served build hash, and orphaned-process checks: run{" "}
                <code>pnpm run health:workflows</code>.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
