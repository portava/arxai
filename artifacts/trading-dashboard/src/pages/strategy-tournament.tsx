import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Swords } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Row = { strategy: string; sample: number; winRate: number; avgR: number; profitFactor: number | null; expectancy: number; riskAdjustedReturn: number; qualitySetups: number; confidenceAccuracy: number | null; riskDiscipline: number | null; tradeGradeAvg: number };
type Result = { running: boolean; idleReason?: "NOT_STARTED" | "SHADOW_STOPPED" | null; startedAt: string | null; shadowStartedAt?: string | null; ranked: Row[]; unranked?: Array<{ strategy: string; decisions: number; reason: string }>; leaderboard: Record<string, string | null> };

async function api(path: string, init?: RequestInit) {
  return fetch(path, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then((r) => r.json());
}

const PAGE_ICON = <Swords className="h-6 w-6 text-primary" />;

function utcMinute(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

// What an empty table means depends on why it is empty. The server leaves out
// "No Trade Filter" placeholder scans (every strategy said WAIT), so a running
// tournament whose scans found nothing actionable has no rows at all — that
// is not "start shadow mode and tournament".
function emptyTableText(r: Result): string {
  if ((r.unranked?.length ?? 0) > 0) return "No strategy has a tracked win or loss yet, so none is ranked.";
  if (r.running) {
    // startedAt is when the tournament was started. It collects decisions only
    // while shadow mode runs, and shadow mode can be stopped and restarted
    // without changing startedAt, so "running since" is claimed only when
    // shadow mode has run since the tournament started.
    const since = utcMinute(r.startedAt);
    const shadowSince = utcMinute(r.shadowStartedAt ?? null);
    const quiet = "the scans so far found no actionable signal, or no scan has run yet.";
    if (!since) return `Running. No strategy has proposed a trade since it started: ${quiet}`;
    if (shadowSince) {
      // startTournament starts shadow mode itself, a moment after startedAt.
      const continuous = Date.parse(r.shadowStartedAt!) - Date.parse(r.startedAt!) <= 1000;
      if (continuous) return `Running since ${since}. No strategy has proposed a trade since it started: ${quiet}`;
      return `Tournament started ${since}; shadow mode, which it collects decisions from, has run since ${shadowSince} ` +
        "(it was stopped and restarted after the tournament started, and nothing was collected while it was stopped). " +
        `No strategy has proposed a trade in the scans collected: ${quiet}`;
    }
    return `Tournament started ${since}; it is running now. It collects decisions only while shadow mode runs, ` +
      "and when shadow mode last started was not reported, so time it was stopped may not be covered. " +
      `No strategy has proposed a trade in the scans collected: ${quiet}`;
  }
  if (r.idleReason === "SHADOW_STOPPED") {
    return "No data yet — the tournament is started, but shadow mode is stopped, so no decisions are being made. Start shadow mode to collect them.";
  }
  if (r.idleReason === "NOT_STARTED") {
    return "No data yet — the tournament has not been started. Press Start tournament; it collects decisions while shadow mode runs.";
  }
  return "No data yet — the tournament is not running. It collects decisions while the tournament and shadow mode both run.";
}

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
        {r && <Badge className={r.running ? "bg-emerald-500/20 text-emerald-400" : ""}>{r.running ? "RUNNING" : r.idleReason === "SHADOW_STOPPED" ? "IDLE — shadow mode is stopped" : "IDLE"}</Badge>}
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
                <thead><tr className="text-left text-muted-foreground"><th>Strategy</th><th>n</th><th>WR%</th><th>avgR</th><th>PF</th><th>Exp</th><th>RAR</th><th>Conf acc</th><th>Risk disc</th><th title="Average of each decision's grade, which is its confidence ÷ 10 — not an independent trade grade">Grade (conf÷10)</th></tr></thead>
                <tbody>
                  {r.ranked.map((row) => (
                    <tr key={row.strategy} className="border-t">
                      <td className="py-1">{row.strategy}</td>
                      <td>{row.sample}</td>
                      <td>{row.winRate}</td>
                      <td>{row.avgR}</td>
                      <td title={row.profitFactor == null ? "No R lost yet, so profit factor cannot be computed" : undefined}>{row.profitFactor ?? "n/a"}</td>
                      <td>{row.expectancy}</td>
                      <td>{row.riskAdjustedReturn}</td>
                      <td>{row.confidenceAccuracy ?? "n/a"}</td>
                      <td>{row.riskDiscipline ?? "n/a"}</td>
                      <td>{row.tradeGradeAvg}</td>
                    </tr>
                  ))}
                  {r.ranked.length === 0 && <tr><td colSpan={10} className="text-muted-foreground py-2" data-testid="tournament-empty">{emptyTableText(r)}</td></tr>}
                </tbody>
              </table>
            </div>
            {(r.unranked?.length ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground mt-2" data-testid="tournament-unranked">
                Not ranked (no tracked win or loss yet): {r.unranked!.map((u) => `${u.strategy} (${u.decisions} decision${u.decisions === 1 ? "" : "s"})`).join(", ")}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
