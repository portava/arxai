import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface EnvItem { varName: string; present: boolean; required: boolean; scope: string; note: string; }
interface Blocker { code: string; severity: "INFO" | "WARN" | "CRITICAL"; message: string; }
interface Readiness {
  env: EnvItem[];
  envSummary: { total: number; presentCount: number; missingRequired: string[]; missingOptional: string[]; liveMasterSwitchEnabled: boolean; legacyBridgeTokenPresent: boolean; };
  safety: { platformMode: string; emergencyKillSwitch: boolean; sharedLiveTradingEnabled: boolean; accountRoutingMode: string; demoEnabled: boolean; liveEnabled: boolean; };
  counts: { arxLiveCommandsTotal: number; arxLiveCommandsLast24h: number; mt5CommandsTotal: number; openNeedsReviewMasterTrades: number; recentAdminActions24h: number; };
  modeContext: { nodeEnv: string; isProduction: boolean; };
  launchBlockers: Blocker[];
  noLiveCommandEvidence: { ok: boolean; arxLiveCommandsCount: number; note: string; };
  computedAt: string;
}

function sevColor(s: Blocker["severity"]): string {
  if (s === "CRITICAL") return "bg-danger text-foreground";
  if (s === "WARN") return "bg-warning text-black";
  return "bg-secondary text-black";
}

export default function LaunchReadinessPage() {
  const [data, setData] = useState<Readiness | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/launch-readiness", { credentials: "include" });
        const j = await r.json();
        if (cancel) return;
        if (!r.ok || !j?.ok) { setErr(j?.error ?? `HTTP ${r.status}`); }
        else setData(j.readiness);
      } catch (e) { if (!cancel) setErr((e as Error).message); }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, []);

  if (loading) return <div className="p-6">Loading launch readiness…</div>;
  if (err) return <div className="p-6 text-danger" data-testid="text-readiness-error">Cannot load: {err}</div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-4" data-testid="page-launch-readiness">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Production Launch Readiness</h1>
        <Badge variant="outline">NODE_ENV={data.modeContext.nodeEnv}</Badge>
      </div>

      <Card>
        <CardHeader><CardTitle>Launch Blockers</CardTitle></CardHeader>
        <CardContent>
          {data.launchBlockers.length === 0 ? (
            <div className="text-success" data-testid="text-no-blockers">No launch blockers detected.</div>
          ) : (
            <ul className="space-y-2">
              {data.launchBlockers.map((b, i) => (
                <li key={i} className="flex items-start gap-2" data-testid={`row-blocker-${b.code}`}>
                  <span className={`px-2 py-0.5 text-xs rounded ${sevColor(b.severity)}`}>{b.severity}</span>
                  <div><div className="font-mono text-sm">{b.code}</div><div className="text-sm text-muted-foreground">{b.message}</div></div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Safety Posture</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>Platform mode: <span className="font-mono">{data.safety.platformMode}</span></div>
            <div>Emergency kill switch: <span className="font-mono">{String(data.safety.emergencyKillSwitch)}</span></div>
            <div>Shared live trading enabled: <span className="font-mono">{String(data.safety.sharedLiveTradingEnabled)}</span></div>
            <div>Account routing: <span className="font-mono">{data.safety.accountRoutingMode}</span></div>
            <div>Demo enabled: <span className="font-mono">{String(data.safety.demoEnabled)}</span></div>
            <div>Live enabled: <span className="font-mono">{String(data.safety.liveEnabled)}</span></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>No-Live-Command Evidence</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>arx_live_commands total: <span className="font-mono" data-testid="text-arx-live-count">{data.noLiveCommandEvidence.arxLiveCommandsCount}</span></div>
            <div>Status: <span className={data.noLiveCommandEvidence.ok ? "text-success" : "text-danger"}>{data.noLiveCommandEvidence.ok ? "STRICT-ZERO INTACT" : "REVIEW REQUIRED"}</span></div>
            <div className="text-xs text-muted-foreground">{data.noLiveCommandEvidence.note}</div>
            <div className="pt-2">Live commands last 24h: <span className="font-mono">{data.counts.arxLiveCommandsLast24h}</span></div>
            <div>mt5_commands total: <span className="font-mono">{data.counts.mt5CommandsTotal}</span></div>
            <div>Open NEEDS_REVIEW master trades: <span className="font-mono">{data.counts.openNeedsReviewMasterTrades}</span></div>
            <div>Admin actions 24h: <span className="font-mono">{data.counts.recentAdminActions24h}</span></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Environment Variable Checklist (masked)</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-2">Presence only. Values are never read, returned, or logged.</div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th>Var</th><th>Scope</th><th>Required</th><th>Present</th><th>Note</th></tr></thead>
            <tbody>
              {data.env.map((e) => (
                <tr key={e.varName} className="border-t" data-testid={`row-env-${e.varName}`}>
                  <td className="font-mono py-1">{e.varName}</td>
                  <td>{e.scope}</td>
                  <td>{e.required ? "yes" : "no"}</td>
                  <td><span className={e.present ? "text-success" : (e.required ? "text-danger" : "text-muted-foreground")}>{e.present ? "✓" : "✗"}</span></td>
                  <td className="text-xs text-muted-foreground">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">Computed at {data.computedAt}. This panel is read-only and is itself audited (ADMIN_VIEWED_LAUNCH_READINESS).</div>
    </div>
  );
}
