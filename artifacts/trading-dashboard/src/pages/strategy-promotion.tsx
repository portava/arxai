import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp } from "lucide-react";
import { AccessCheckingShell, AccessDeniedCard, SHADOW_ADMIN_DENIED_NOTE, shadowAdminDeniedMessage } from "@/components/access/AdminOnlyGate";

type StratGate = { strategy: string; level: string; demotion: string | null; updatedAt: string | null; lastReason: string | null; eligibleFor: string | null; stats: { sample: number; tracked: number; winRate: number; avgR: number; drawdownR: number; rgViolations: number; expectancy: number } };
type Resp = { strategies: StratGate[]; demotionSuggestions: Array<{ strategy: string; suggested: string | null; reasons: string[]; tracked?: number }> };

const LEVEL_COLOR: Record<string, string> = { TESTING: "bg-slate-500/20 text-slate-300", WATCHLIST: "bg-blue-500/20 text-blue-400", PAPER_APPROVED: "bg-amber-500/20 text-amber-400", DEMO_APPROVED: "bg-emerald-500/20 text-emerald-400", LIVE_INTENT_APPROVED: "bg-violet-500/20 text-violet-300", FUTURE_MT5_LIVE_LOCKED: "bg-rose-500/20 text-rose-400" };

async function api(path: string, init?: RequestInit) { return fetch(path, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then((r) => r.json()); }

const PAGE_ICON = <TrendingUp className="h-6 w-6 text-primary" />;

/** "Nothing to demote" with how much was actually checked. */
function noDemotionText(rows: Resp["demotionSuggestions"]): string {
  const n = rows.length;
  const base = `No demotions suggested for the ${n} strateg${n === 1 ? "y" : "ies"} checked.`;
  if (rows.some((d) => d.tracked == null)) return base;
  const enough = rows.filter((d) => (d.tracked ?? 0) >= 10).length;
  return `${base} ${enough} of ${n} had the 10+ tracked outcomes the win-rate and R checks need.`;
}

export default function StrategyPromotion() {
  // Admin/OWNER-only endpoint (/api/strategy-promotion). Non-admins get the
  // denied state immediately and fire ZERO gated calls.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [r, setR] = useState<Resp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/strategy-promotion");
      if (!res.ok) throw Object.assign(new Error("load failed"), { status: res.status });
      setLoadError(null); setR(await res.json());
    } catch (err) {
      const e = err as { status?: number };
      setLoadError(e.status === 403 || e.status === 401 ? shadowAdminDeniedMessage("Strategy Promotion Gates") : "Could not load Strategy Promotion Gates.");
    }
  }
  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    void load(); const id = setInterval(load, 4000); return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  if (roleLoading) return <AccessCheckingShell icon={PAGE_ICON} title="Strategy Promotion Gates" />;
  if (roleDenied || loadError) {
    return (
      <AccessDeniedCard
        icon={PAGE_ICON}
        title="Strategy Promotion Gates"
        message={roleDenied ? shadowAdminDeniedMessage("Strategy Promotion Gates") : loadError!}
        note={SHADOW_ADMIN_DENIED_NOTE}
        onRetry={roleDenied ? undefined : () => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <TrendingUp className="h-6 w-6 text-primary" />
        <div className="flex-1"><h1 className="text-2xl font-bold">Strategy Promotion Gates</h1>
          <p className="text-sm text-muted-foreground">A strategy can only be promoted one level at a time and only if it meets the gate. FUTURE_MT5_LIVE_LOCKED is permanent until the bridge is wired.</p>
        </div>
        <Badge variant="outline">SHADOW</Badge>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Strategies</CardTitle><CardDescription>Eligible-for column shows the next reachable level given current shadow stats.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {r?.strategies.map((s) => (
            <div key={s.strategy} className="border rounded p-2 text-xs space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.strategy}</span>
                <Badge className={LEVEL_COLOR[s.level]}>{s.level === "PAPER_APPROVED" ? "DEMO_APPROVED" : s.level}</Badge>
                {s.demotion && <Badge variant="destructive">demotion: {s.demotion}</Badge>}
                {s.eligibleFor && <Badge className="bg-emerald-500/20 text-emerald-400">eligible → {s.eligibleFor}</Badge>}
                <span className="ml-auto text-muted-foreground">{s.stats.tracked > 0
                  ? `n=${s.stats.sample} tracked=${s.stats.tracked} wr=${(s.stats.winRate * 100).toFixed(0)}% avgR=${s.stats.avgR.toFixed(2)} exp=${s.stats.expectancy.toFixed(2)}`
                  : `n=${s.stats.sample} · no tracked win or loss yet, so no win rate or R`}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={!s.eligibleFor} onClick={() => api("/api/strategy-promotion/promote", { method: "POST", body: JSON.stringify({ strategy: s.strategy }) }).then(load)}>Promote</Button>
                <Button size="sm" variant="outline" onClick={() => api("/api/strategy-promotion/demote", { method: "POST", body: JSON.stringify({ strategy: s.strategy, level: "PAUSED", reason: "manual" }) }).then(load)}>Demote: Paused</Button>
                <Button size="sm" variant="outline" onClick={() => api("/api/strategy-promotion/demote", { method: "POST", body: JSON.stringify({ strategy: s.strategy, level: "RETIRED", reason: "manual" }) }).then(load)}>Retire</Button>
                <span className="text-muted-foreground">{s.lastReason ?? "No promotion or demotion recorded yet."}</span>
              </div>
            </div>
          ))}
          {r && r.strategies.length === 0 && <p className="text-xs text-muted-foreground">No strategy has made a shadow decision yet.</p>}
        </CardContent>
      </Card>
      {r && (
        <Card>
          <CardHeader><CardTitle className="text-base">Demotion suggestions</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {r.demotionSuggestions.filter((d) => d.suggested).map((d) => (
              <div key={d.strategy} className="border rounded p-2 flex items-center gap-2">
                <span className="font-semibold w-56">{d.strategy}</span>
                <Badge variant="destructive">{d.suggested}</Badge>
                <span className="text-muted-foreground">{d.reasons.join(", ")}</span>
              </div>
            ))}
            {r.demotionSuggestions.length > 0 && r.demotionSuggestions.every((d) => !d.suggested) && <p className="text-muted-foreground">{noDemotionText(r.demotionSuggestions)}</p>}
            {r.demotionSuggestions.length === 0 && <p className="text-muted-foreground">No strategy has made a shadow decision yet, so none was checked for demotion.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
