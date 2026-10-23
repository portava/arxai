import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Shield, Pause, Play, RotateCcw, Gauge, SlidersHorizontal, ClipboardList, ScrollText } from "lucide-react";
import { PageTabs } from "@/components/ui/PageTabs";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { CompactAlert } from "@/components/ui/CompactAlert";

type Profile = Record<string, unknown> & { profileName: string; preset: string; maxRiskPerTradeUsd: number; maxDailyLossUsd: number; maxLotSize: number; minRiskReward: number };
type Budget = { dailyRiskLimit: number; dailyRiskUsed: number; dailyRiskRemaining: number; weeklyRiskLimit: number; weeklyRiskUsed: number; openRisk: number; currentDrawdownUsd: number; maxDrawdownAllowed: number; riskStatus: string };
type Cards = { riskStatus: string; dailyRiskRemaining: number; openRisk: number; drawdownStatus: string; exposureStatus: string; overtradingRisk: string; activeRiskLocks: string[]; aiRiskDiscipline: number; permissions: { aiTrading: boolean; manualTrading: boolean; simulator: boolean; liveTesterIntent: boolean; futureMt5: boolean; pauseReason: string | null }; propFirm: { status: string; profitTargetProgress: number } | null };

const STATUS_COLOR: Record<string, string> = {
  OK: "bg-success/20 text-success",
  CAUTION: "bg-warning/20 text-warning",
  BLOCK: "bg-danger/20 text-danger",
  NORMAL: "bg-success/20 text-success",
  OVERTRADING_RISK: "bg-warning/20 text-warning",
  REVENGE_TRADING_RISK: "bg-danger/20 text-danger",
  HARD_BLOCK: "bg-danger/20 text-danger",
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, { headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  return r.json();
}

/**
 * Risk Command Center — simple-first 4-tab layout.
 *   Summary — at-a-glance status, blocking alerts, budget snapshot.
 *   Limits  — risk profile preset, max-risk/day/lot/RR limits, budget detail.
 *   Rules   — permission booleans + active risk locks.
 *   Audit   — pause/resume/reset controls, risk-event log, profile editor.
 *
 * Account protection logic is unchanged — only the surface is reorganised.
 * MT5 broker permission stays OFF regardless of what tab is open.
 */
export default function RiskCommandCenter() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [cards, setCards] = useState<Cards | null>(null);
  const [pauseReason, setPauseReason] = useState("Manual pause");

  async function load() {
    const [p, b, c] = await Promise.all([
      fetch("/api/risk-profile").then((r) => r.json()),
      fetch("/api/risk/budget").then((r) => r.json()),
      fetch("/api/risk/dashboard-cards").then((r) => r.json()),
    ]);
    setProfile(p); setBudget(b); setCards(c);
  }
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, []);

  async function applyPreset(preset: string) { await api(`/api/risk-profile/preset/${preset}`, { method: "POST" }); load(); }
  async function pause() { await api("/api/risk/pause", { method: "POST", body: JSON.stringify({ reason: pauseReason }) }); load(); }
  async function resume() { await api("/api/risk/resume", { method: "POST" }); load(); }
  async function resetDay() { await api("/api/risk/reset-simulator-day", { method: "POST" }); load(); }

  // ---- Tab contents -----------------------------------------------------

  const summaryTab = (
    <div className="space-y-3" data-testid="risk-summary-tab">
      {cards?.permissions.pauseReason && (
        <CompactAlert
          tone="danger"
          title="Trading paused by account protection"
          description={cards.permissions.pauseReason}
          details={<p>Resume from the Audit tab once the reason is resolved. Live broker dispatch stays OFF.</p>}
          testId="risk-paused-alert"
        />
      )}

      {cards && (
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
          <Stat label="Daily risk left" value={`$${cards.dailyRiskRemaining}`} />
          <Stat label="Open risk" value={`$${cards.openRisk}`} />
          <Stat label="Drawdown" value={cards.drawdownStatus} />
          <Stat label="Exposure" value={cards.exposureStatus} />
          <Stat label="Overtrading" value={cards.overtradingRisk} />
          <Stat label="AI discipline" value={`${cards.aiRiskDiscipline}/100`} />
          <Stat label="MT5" value={cards.permissions.futureMt5 ? "ON" : "DEFERRED"} />
          <Stat label="Active locks" value={cards.activeRiskLocks.length === 0 ? "none" : String(cards.activeRiskLocks.length)} />
        </div>
      )}

      {cards && cards.activeRiskLocks.length > 0 && (
        <CompactAlert
          tone="warning"
          title={`${cards.activeRiskLocks.length} active risk lock${cards.activeRiskLocks.length === 1 ? "" : "s"}`}
          description={cards.activeRiskLocks.join(", ")}
          testId="risk-active-locks"
        />
      )}
    </div>
  );

  const limitsTab = (
    <div className="space-y-3" data-testid="risk-limits-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Risk Profile · {profile?.preset}</CardTitle>
          <CardDescription>
            {profile?.profileName} · max risk/trade ${profile?.maxRiskPerTradeUsd} · max daily loss ${profile?.maxDailyLossUsd} · max lot {profile?.maxLotSize} · min R:R {profile?.minRiskReward}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {["ULTRA_CONSERVATIVE", "CONSERVATIVE", "BALANCED_TESTER", "AGGRESSIVE_SIMULATOR", "PROP_FIRM_CHALLENGE"].map((p) => (
            <Button
              key={p}
              size="sm"
              variant={profile?.preset === p ? "default" : "outline"}
              onClick={() => applyPreset(p)}
              data-testid={`risk-preset-${p}`}
            >{p}</Button>
          ))}
        </CardContent>
      </Card>

      {budget && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Risk Budget</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <Stat label="Daily limit" value={`$${budget.dailyRiskLimit}`} />
            <Stat label="Daily used" value={`$${budget.dailyRiskUsed}`} />
            <Stat label="Weekly limit" value={`$${budget.weeklyRiskLimit}`} />
            <Stat label="Weekly used" value={`$${budget.weeklyRiskUsed}`} />
            <Stat label="Open risk" value={`$${budget.openRisk}`} />
            <Stat label="Drawdown" value={`$${budget.currentDrawdownUsd}`} />
            <Stat label="Max DD allowed" value={`$${budget.maxDrawdownAllowed}`} />
            <Stat label="Status" value={budget.riskStatus} />
          </CardContent>
        </Card>
      )}
    </div>
  );

  const rulesTab = (
    <div className="space-y-3" data-testid="risk-rules-tab">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Permissions</CardTitle>
          <CardDescription>Each rule below maps directly to a safety gate in the dispatch pipeline.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1">
          {cards && Object.entries(cards.permissions).filter(([k]) => k !== "pauseReason").map(([k, v]) => (
            <Badge key={k} variant={v ? "default" : "destructive"} data-testid={`risk-perm-${k}`}>
              {k}: {String(v)}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <CollapsibleSection
        title="Prop-firm rules"
        description={cards?.propFirm ? `Status ${cards.propFirm.status}` : "Open only when a prop-firm challenge is active."}
        storageKey="risk.propFirm"
        testId="risk-propfirm-section"
      >
        {cards?.propFirm ? (
          <div className="text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span className="font-mono">{cards.propFirm.status}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Profit target progress</span><span className="font-mono">{cards.propFirm.profitTargetProgress}%</span></div>
            <a className="text-xs underline text-primary block mt-2" href="/prop-firm-mode">Open prop-firm mode →</a>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No active prop-firm challenge. Open <a href="/prop-firm-mode" className="underline">prop-firm mode</a> to enroll.</p>
        )}
      </CollapsibleSection>
    </div>
  );

  const auditTab = (
    <div className="space-y-3" data-testid="risk-audit-tab">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Controls</CardTitle>
          <CardDescription className="text-xs">Pause/resume halts every dispatch surface. Reset is simulator-only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="pause reason"
            data-testid="risk-pause-reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={pause} variant="destructive" size="sm" data-testid="risk-btn-pause"><Pause className="h-4 w-4 mr-1" />Pause all trading</Button>
            <Button onClick={resume} variant="outline" size="sm" data-testid="risk-btn-resume"><Play className="h-4 w-4 mr-1" />Resume</Button>
            <Button onClick={resetDay} variant="outline" size="sm" data-testid="risk-btn-reset"><RotateCcw className="h-4 w-4 mr-1" />Reset simulator day</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Audit links</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <a className="underline text-primary" href="/risk-events">Risk events log →</a>
          <a className="underline text-primary" href="/risk-profile">Edit profile JSON →</a>
          <a className="underline text-primary" href="/audit-log">Full audit log →</a>
          <a className="underline text-primary" href="/risk-settings">Detailed risk settings →</a>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="space-y-4 pb-32 md:pb-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className="h-6 w-6 text-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-bold">Risk Command Center</h1>
          <p className="text-xs md:text-sm text-muted-foreground">Account protection layer — controls execution decisions, never navigation. MT5 broker permission stays OFF.</p>
        </div>
        <Badge variant="outline" className="text-[11px]">SIMULATOR</Badge>
        {cards && <Badge className={`text-[11px] ${STATUS_COLOR[cards.riskStatus] ?? ""}`} data-testid="risk-status-badge">{cards.riskStatus}</Badge>}
      </div>

      <PageTabs
        storageKey="risk-command-center"
        defaultTab="summary"
        tabs={[
          { id: "summary", label: "Summary", icon: <Gauge className="h-3.5 w-3.5" />,            content: summaryTab },
          { id: "limits",  label: "Limits",  icon: <SlidersHorizontal className="h-3.5 w-3.5" />, content: limitsTab },
          { id: "rules",   label: "Rules",   icon: <ClipboardList className="h-3.5 w-3.5" />,    content: rulesTab },
          { id: "audit",   label: "Audit",   icon: <ScrollText className="h-3.5 w-3.5" />,       content: auditTab },
        ]}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2">
    <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
    <p className="text-sm font-mono font-semibold">{value}</p>
  </CardContent></Card>;
}
