import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Shield, Pause, Play, Gauge, SlidersHorizontal, ClipboardList, ScrollText } from "lucide-react";
import { PageTabs } from "@/components/ui/PageTabs";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { CompactAlert } from "@/components/ui/CompactAlert";

type Settings = { maxRiskPerTradeAmount: number | null; maxDailyLossAmount: number | null; maxPositionSize: number | null; minRewardRiskRatio: number; maxTradesPerDay: number; maxOpenTrades: number };
type Limits = { maxLotSize: number; maxDailyLossPercent: number | null; maxDailyLossAmount: number | null; maxRiskPerTradePercent: number; maxRiskPerTradeAmount: number | null; discipline: { maxTradesPerDay: number | null; maxOpenTrades: number | null } };
type Profile = { preset: string; settings: Settings; effectiveLimits: Limits };
type Money = number | null;
type Budget = { venue: string; dailyRiskLimit: Money; dailyRiskUsed: number; dailyRiskRemaining: Money; weeklyRiskLimit: Money; weeklyRiskUsed: number; openRisk: number; openPositions: number; equity: Money; riskStatus: string };
type Cards = { venue: string; riskStatus: string; dailyRiskRemaining: Money; weeklyRiskRemaining: Money; openRisk: number; openPositions: number; tradesToday: number | null; consecutiveLosses: number | null; overtrading: string; activeHalts: string[]; permissions: { trading: boolean; pauseReason: string | null }; propFirm: { status: string; profitTargetProgress: number } | null };

const usd = (v: Money) => (v == null ? "none set" : `$${v}`);

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
  const r = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  return r.json();
}

/**
 * Risk Command Center — simple-first 4-tab layout.
 *   Summary — at-a-glance status, blocking alerts, budget snapshot.
 *   Limits  — risk profile preset, max-risk/day/lot/RR limits, budget detail.
 *   Rules   — permission booleans + active risk locks.
 *   Audit   — pause/resume/reset controls, risk-event log, profile editor.
 *
 * Everything here is YOUR account: presets write into your own risk
 * settings, which the Risk Governor enforces on every order (an admin or
 * platform limit always wins if it is stricter). Pause engages your own kill
 * switch; it never halts other traders.
 */
export default function RiskCommandCenter() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [cards, setCards] = useState<Cards | null>(null);
  const [pauseReason, setPauseReason] = useState("Manual pause");

  async function load() {
    const [p, b, c] = await Promise.all([
      api("/api/risk-profile"),
      api("/api/risk/budget"),
      api("/api/risk/dashboard-cards"),
    ]);
    setProfile(p); setBudget(b); setCards(c);
  }
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, []);

  async function applyPreset(preset: string) { await api(`/api/risk-profile/preset/${preset}`, { method: "POST" }); load(); }
  async function pause() { await api("/api/risk/pause", { method: "POST", body: JSON.stringify({ reason: pauseReason }) }); load(); }
  async function resume() { await api("/api/risk/resume", { method: "POST" }); load(); }

  // ---- Tab contents -----------------------------------------------------

  const summaryTab = (
    <div className="space-y-3" data-testid="risk-summary-tab">
      {cards?.permissions.pauseReason && (
        <CompactAlert
          tone="danger"
          title="New trades are halted on your account"
          description={cards.permissions.pauseReason}
          details={<p>If this is your own pause, resume it from the Audit tab. Closing positions stays available.</p>}
          testId="risk-paused-alert"
        />
      )}

      {cards && (
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
          <Stat label="Daily risk left" value={usd(cards.dailyRiskRemaining)} />
          <Stat label="Weekly risk left" value={usd(cards.weeklyRiskRemaining)} />
          <Stat label="Open risk" value={`$${cards.openRisk}`} />
          <Stat label="Open positions" value={String(cards.openPositions)} />
          <Stat label="Trades today" value={cards.tradesToday == null ? "—" : String(cards.tradesToday)} />
          <Stat label="Losses in a row" value={cards.consecutiveLosses == null ? "—" : String(cards.consecutiveLosses)} />
          <Stat label="Overtrading" value={cards.overtrading} />
          <Stat label="Active halts" value={cards.activeHalts.length === 0 ? "none" : String(cards.activeHalts.length)} />
        </div>
      )}

      {cards && cards.activeHalts.length > 0 && (
        <CompactAlert
          tone="warning"
          title={`${cards.activeHalts.length} active stop switch${cards.activeHalts.length === 1 ? "" : "es"}`}
          description={cards.activeHalts.join(", ")}
          testId="risk-active-locks"
        />
      )}
    </div>
  );

  const limitsTab = (
    <div className="space-y-3" data-testid="risk-limits-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your risk profile · {profile?.preset}</CardTitle>
          <CardDescription>
            In force (strictest of yours, admin and platform): max lot {profile?.effectiveLimits.maxLotSize} · risk/trade {profile?.effectiveLimits.maxRiskPerTradePercent}%{profile?.effectiveLimits.maxRiskPerTradeAmount != null ? ` or $${profile.effectiveLimits.maxRiskPerTradeAmount}` : ""} · daily loss {profile?.effectiveLimits.maxDailyLossPercent ?? "—"}%{profile?.effectiveLimits.maxDailyLossAmount != null ? ` or $${profile.effectiveLimits.maxDailyLossAmount}` : ""} · trades/day {profile?.effectiveLimits.discipline.maxTradesPerDay ?? "—"} · open trades {profile?.effectiveLimits.discipline.maxOpenTrades ?? "—"} · min R:R {profile?.settings.minRewardRiskRatio}
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
            <Stat label="Daily limit" value={usd(budget.dailyRiskLimit)} />
            <Stat label="Daily used" value={`$${budget.dailyRiskUsed}`} />
            <Stat label="Weekly limit" value={usd(budget.weeklyRiskLimit)} />
            <Stat label="Weekly used" value={`$${budget.weeklyRiskUsed}`} />
            <Stat label="Open risk" value={`$${budget.openRisk}`} />
            <Stat label="Equity" value={usd(budget.equity)} />
            <Stat label="Venue" value={budget.venue} />
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
          <CardDescription>Whether your account can open new trades right now. Every order is still checked by the Risk Governor.</CardDescription>
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
          <CardDescription className="text-xs">Pause engages your own kill switch: new trades on your account stop on every venue, closing stays open. It never affects other traders.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="pause reason"
            data-testid="risk-pause-reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={pause} variant="destructive" size="sm" data-testid="risk-btn-pause"><Pause className="h-4 w-4 mr-1" />Pause my trading</Button>
            <Button onClick={resume} variant="outline" size="sm" data-testid="risk-btn-resume"><Play className="h-4 w-4 mr-1" />Resume</Button>
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
          <p className="text-xs md:text-sm text-muted-foreground">Your limits and budget as the Risk Governor enforces them.</p>
        </div>
        {cards && <Badge variant="outline" className="text-[11px]">{cards.venue}</Badge>}
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
