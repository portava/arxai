import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Swords } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Row = { strategy: string; sample: number; winRate: number; avgR: number; profitFactor: number; expectancy: number; riskAdjustedReturn: number; qualitySetups: number; confidenceAccuracy: number; riskDiscipline: number; tradeGradeAvg: number };
type Result = { running: boolean; startedAt: string | null; ranked: Row[]; leaderboard: Record<string, string | null> };

async function api(path: string, init?: RequestInit) {
  return fetch(path, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then((r) => r.json());
}

const PAGE_ICON = <Swords className="h-6 w-6 text-primary" />;

// Rendered as the Testing Lab "Tournament" tab (surface consolidation item
// C); the old standalone /strategy-tournament route redirects to
// /testing-lab?tab=tournament and the nav entry is gone.
export default function StrategyTournament() {
  // Admin/OWNER-only endpoint (/api/strategy-tournament/results). Non-admins get
  // the denied state immediately and fire ZERO gated calls.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [r, setR] = useState<Result | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/strategy-tournament/results");
      if (!res.ok) throw Object.assign(new Error("load failed"), { status: res.status });
      setLoadError(null); setR(await res.json());
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("the Strategy Tournament") : "Could not load the Strategy Tournament.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="Strategy Tournament" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="Strategy Tournament"
        message={roleDenied ? shadowAdminDeniedMessage("the Strategy Tournament") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Swords className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold">Strategy Tournament</h1></div>
        <Badge variant="outline">SHADOW</Badge>
        {r && <Badge className={r.running ? "bg-emerald-500/20 text-emerald-400" : ""}>{r.running ? "RUNNING" : "IDLE"}</Badge>}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Controls</CardTitle></CardHeader>
        <CardContent>
          <Button onClick={() => api("/api/strategy-tournament/start", { method: "POST" }).then(load)}>Start tournament</Button>
        </CardContent>
      </Card>
      {r && (
        <Card>
          <CardHeader><CardTitle className="text-base">Leaderboard</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {Object.entries(r.leaderboard).map(([k, v]) => (
              <Card key={k}><CardContent className="p-2"><p className="text-[10px] text-muted-foreground uppercase">{k}</p><p className="text-sm font-semibold">{v ?? "—"}</p></CardContent></Card>
            ))}
          </CardContent>
        </Card>
      )}
      {r && (
        <Card>
          <CardHeader><CardTitle className="text-base">Ranked strategies</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th>Strategy</th><th>n</th><th>WR%</th><th>avgR</th><th>PF</th><th>Exp</th><th>RAR</th><th>Conf acc</th><th>Risk disc</th><th>Grade</th></tr></thead>
                <tbody>
                  {r.ranked.map((row) => (
                    <tr key={row.strategy} className="border-t">
                      <td className="py-1">{row.strategy}</td>
                      <td>{row.sample}</td>
                      <td>{row.winRate}</td>
                      <td>{row.avgR}</td>
                      <td>{row.profitFactor}</td>
                      <td>{row.expectancy}</td>
                      <td>{row.riskAdjustedReturn}</td>
                      <td>{row.confidenceAccuracy}</td>
                      <td>{row.riskDiscipline}</td>
                      <td>{row.tradeGradeAvg}</td>
                    </tr>
                  ))}
                  {r.ranked.length === 0 && <tr><td colSpan={10} className="text-muted-foreground py-2">No data yet — start shadow mode and tournament.</td></tr>}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
