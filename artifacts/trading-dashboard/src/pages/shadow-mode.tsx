import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Eye, Play, StopCircle } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type Status = { enabled: boolean; startedAt: string | null; totalsObserved: number; totalDecisions: number; tracking: number; wins: number; losses: number; breakevens: number; expired: number; rejected: number; waits: number };
type Dec = { id: string; ts: string; symbol: string; strategy: string; marketCondition: string; action: string; entry: number; sl: number; tp: number; confidence: number; status: string; pnlR?: number; reason: string; reasonToAvoid: string; riskGovernor: { approved: boolean; level: string; hardBlocks: string[] } };

const STATUS_COLOR: Record<string, string> = { SHADOW_WIN: "bg-success/20 text-success", SHADOW_LOSS: "bg-danger/20 text-danger", SHADOW_BREAKEVEN: "bg-muted text-txt-secondary", SHADOW_TRACKING_OUTCOME: "bg-primary/20 text-primary", SHADOW_REJECTED: "bg-warning/20 text-warning", SHADOW_WAIT: "bg-muted text-txt-secondary", SHADOW_EXPIRED: "bg-muted text-txt-secondary" };

async function api(path: string, init?: RequestInit) {
  return fetch(path, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then((r) => r.json());
}

const PAGE_ICON = <Eye className="h-6 w-6 text-primary" />;

// Rendered as the Testing Lab "Shadow Mode" tab (surface consolidation item
// C); the old standalone /shadow-mode route redirects to
// /testing-lab?tab=shadow and the nav entry is gone.
export default function ShadowMode() {
  // Cached /api/me role pre-check: Shadow Mode is backed entirely by
  // admin/OWNER-only endpoints, so non-admins get the denied state immediately
  // and fire ZERO gated calls. Server requireAdmin remains the authority.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [s, setS] = useState<Status | null>(null);
  const [decs, setDecs] = useState<Dec[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const [stRes, ddRes] = await Promise.all([fetch("/api/shadow-mode/status"), fetch("/api/shadow-mode/decisions?limit=50")]);
      if (!stRes.ok || !ddRes.ok) throw Object.assign(new Error("load failed"), { status: !stRes.ok ? stRes.status : ddRes.status });
      const st = await stRes.json(); const dd = await ddRes.json();
      setLoadError(null); setS(st); setDecs(dd.decisions ?? []);
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("Shadow Mode") : "Could not load Shadow Mode data.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 3000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="Shadow Mode" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="Shadow Mode"
        message={roleDenied ? shadowAdminDeniedMessage("Shadow Mode") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Eye className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold">Shadow Mode</h1>
          <p className="text-sm text-muted-foreground">AI generates trade ideas and tracks hypothetical outcomes. No simulator orders, no broker calls.</p>
        </div>
        <Badge variant="outline">SHADOW</Badge>
        {s && <Badge className={s.enabled ? "bg-success/20 text-success" : ""}>{s.enabled ? "RUNNING" : "STOPPED"}</Badge>}
      </div>

      {s && (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Decisions observed" value={String(s.totalsObserved)} />
          <Stat label="Tracking" value={String(s.tracking)} />
          <Stat label="Wins" value={String(s.wins)} />
          <Stat label="Losses" value={String(s.losses)} />
          <Stat label="Breakevens" value={String(s.breakevens)} />
          <Stat label="Expired" value={String(s.expired)} />
          <Stat label="Rejected by risk" value={String(s.rejected)} />
          <Stat label="Waits" value={String(s.waits)} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Controls</CardTitle><CardDescription>Shadow scans default symbols every ~5s. Admin-gated.</CardDescription></CardHeader>
        <CardContent className="flex gap-2 flex-wrap">
          <Button onClick={() => api("/api/shadow-mode/start", { method: "POST", body: JSON.stringify({ intervalSec: 5 }) }).then(load)}><Play className="h-4 w-4 mr-1" />Start</Button>
          <Button variant="outline" onClick={() => api("/api/shadow-mode/stop", { method: "POST" }).then(load)}><StopCircle className="h-4 w-4 mr-1" />Stop</Button>
          <Button variant="ghost" onClick={() => api("/api/shadow-mode/decision", { method: "POST", body: JSON.stringify({ symbol: "EURUSD" }) }).then(load)}>Force EURUSD decision</Button>
          <a className="text-xs underline ml-2" href="/testing-lab?tab=forward">Forward testing →</a>
          <a className="text-xs underline" href="/testing-lab?tab=tournament">Tournament →</a>
          <a className="text-xs underline" href="/confidence-calibration">Calibration →</a>
          <a className="text-xs underline" href="/testing-lab?tab=promotion">Promotion →</a>
          <a className="text-xs underline" href="/ai-readiness-score">Readiness →</a>
          <a className="text-xs underline" href="/shadow-journal">Journal →</a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent shadow decisions</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {decs.map((d) => (
            <div key={d.id} className="border rounded p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={STATUS_COLOR[d.status] ?? ""}>{d.status}</Badge>
                <Badge variant="outline">{d.symbol}</Badge>
                <Badge variant="outline">{d.strategy}</Badge>
                <Badge variant="outline">{d.action}</Badge>
                <span className="text-muted-foreground">conf {d.confidence}</span>
                <span className="text-muted-foreground">mc {d.marketCondition}</span>
                {d.pnlR != null && <span className="text-muted-foreground">R={d.pnlR.toFixed(2)}</span>}
                <span className="ml-auto text-muted-foreground">{new Date(d.ts).toLocaleTimeString()}</span>
              </div>
              <div className="text-muted-foreground mt-1">entry {d.entry.toFixed(5)} sl {d.sl.toFixed(5)} tp {d.tp.toFixed(5)}</div>
              <div className="text-muted-foreground">{d.reason}</div>
              {d.reasonToAvoid && <div className="text-danger">avoid: {d.reasonToAvoid}</div>}
            </div>
          ))}
          {decs.length === 0 && <p className="text-xs text-muted-foreground">Start shadow mode to populate decisions.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2"><p className="text-[10px] text-muted-foreground uppercase">{label}</p><p className="text-sm font-mono font-semibold">{value}</p></CardContent></Card>;
}
