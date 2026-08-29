import { useMemo } from "react";
import {
  useGetMt5Status,
  useGetMeSharedAccountSummary,
  getGetMt5StatusQueryKey,
  getGetMeSharedAccountSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  RadioTower, Sparkles, ShieldCheck, UserCheck, Route as RouteIcon,
  Activity, Wifi, RefreshCw, ArrowRight, User, Landmark, CheckCircle2,
  Bell, HelpCircle, ChevronRight,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useAssistantName } from "@/lib/assistant-name";

const RUBY_OPEN_KEY = "arx.assistant.open.v2";
function openRubyLiveChat() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* sessionStorage unavailable — silent */ }
}

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

function fmtMoney(v?: number | null, ccy?: string | null) {
  if (v === null || v === undefined) return "—";
  return `${ccy === "USD" || !ccy ? "$" : ""}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${ccy && ccy !== "USD" ? ` ${ccy}` : ""}`;
}
function fmtAge(seconds?: number | null) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function maskAccount(acct?: string | number | null) {
  if (acct === null || acct === undefined || acct === "") return "—";
  const s = String(acct);
  return s.length <= 4 ? `••••${s}` : `••••${s.slice(-4)}`;
}

type Tone = "success" | "warning" | "danger" | "primary" | "muted";
const TONE_TEXT: Record<Tone, string> = {
  success: "text-success", warning: "text-warning", danger: "text-danger",
  primary: "text-primary", muted: "text-txt-muted",
};
const TONE_DOT: Record<Tone, string> = {
  success: "bg-success", warning: "bg-warning", danger: "bg-danger",
  primary: "bg-primary", muted: "bg-txt-muted",
};

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold",
      tone === "success" ? "border-success/40 bg-success/10 text-success"
      : tone === "warning" ? "border-warning/40 bg-warning/10 text-warning"
      : tone === "danger" ? "border-danger/40 bg-danger/10 text-danger"
      : tone === "primary" ? "border-primary/40 bg-primary/10 text-primary"
      : "border-border bg-secondary/40 text-txt-muted")}>
      {children}
    </span>
  );
}

function StatusTile({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-txt-muted">
        <Icon className={cn("h-3.5 w-3.5", TONE_TEXT[tone])} /> {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-semibold", TONE_TEXT[tone])}>{value}</div>
    </div>
  );
}

function MetricTile({ label, value, tone = "muted" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold", tone === "muted" ? "text-foreground" : TONE_TEXT[tone])}>{value}</div>
    </div>
  );
}

function Row({ label, value, tone = "muted" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-txt-secondary">{label}</span>
      <span className={cn("flex items-center gap-1.5 font-medium", tone === "muted" ? "text-foreground" : TONE_TEXT[tone])}>
        {tone !== "muted" && <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} />}
        {value}
      </span>
    </div>
  );
}

function SectionCard({ title, icon: Icon, action, children, className }: { title: string; icon?: any; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-card p-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary">
          {Icon && <Icon className="h-4 w-4 text-primary" />} {title}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function MT5BridgePage() {
  const qc = useQueryClient();
  const mode = useTradingMode();
  const { name } = useAssistantName();

  const status = useGetMt5Status({ query: { queryKey: getGetMt5StatusQueryKey(), refetchInterval: 5000 } });
  const acctSummary = useGetMeSharedAccountSummary({ query: { queryKey: getGetMeSharedAccountSummaryQueryKey() } } as any);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetMt5StatusQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMeSharedAccountSummaryQueryKey() });
    if (typeof (mode as any).resync === "function") (mode as any).resync();
  };

  const s = status.data as any;
  const acct = (acctSummary?.data ?? null) as { balance?: number; equity?: number; pnl?: number } | null;
  const snapshot = s?.accountSnapshot;

  const connected = !!s?.connected;
  const checking = status.isLoading || (mode as any).isLoading;
  const frozen = !!(mode as any).isFrozen;

  const bridgeState: { label: string; tone: Tone } = useMemo(() => {
    if (checking) return { label: "Checking", tone: "warning" };
    if (frozen) return { label: "Risk Lock Active", tone: "danger" };
    if (connected) return { label: "Connected", tone: "success" };
    return { label: "Unavailable", tone: "warning" };
  }, [checking, frozen, connected]);

  const approvalTone: Tone = frozen ? "danger" : ((mode as any).approvalStatus === "APPROVED" || (mode as any).isLiveShared) ? "success" : "warning";
  const approvalLabel = frozen ? "Frozen" : ((mode as any).approvalStatus === "APPROVED" || (mode as any).isLiveShared) ? "Approved" : ((mode as any).approvalStatus ? "Pending" : "Checking");

  const routeLabel = (mode as any).cleanModeLabel ?? ((mode as any).isLiveShared ? "Live Shared MT5" : (mode as any).isDemo ? "Demo" : "Analysis Only");
  const bridgeHealthy = connected && !frozen;
  const allocation = (mode as any).userAllocation ?? (mode as any).assignedStartingBalance ?? null;
  const openPnl = acct?.pnl ?? null;
  const openTrades = Array.isArray(s?.openPositions) ? s.openPositions.length : null;
  const lastSync = fmtAge(s?.secondsSinceHeartbeat ?? null);

  const riskTone: Tone = frozen ? "danger" : "success";
  const riskLabel = frozen ? "High" : "Low";

  if (checking) {
    return (
      <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const rubyRead = frozen
    ? "Your account is currently risk-locked, so live execution is paused. Market analysis and the scanner stay available. Clear the lock from Risk Settings, then your route will reopen."
    : connected
      ? "Your trading route is healthy. The shared MT5 bridge is connected, market data is active, and your account is approved. You can prepare trades normally. If the bridge disconnects, ARX will pause live execution until the connection returns."
      : "The shared MT5 bridge is not connected right now, so live execution is paused. You can still analyze the market and prepare ideas. Live routing resumes automatically when the bridge reconnects.";

  const activity: { time: string; event: string; tone: Tone; chip: string }[] = [];
  if (s?.secondsSinceHeartbeat != null) {
    activity.push({ time: lastSync, event: connected ? "Market data heartbeat" : "Last heartbeat received", tone: connected ? "success" : "warning", chip: connected ? "Connected" : "Stale" });
  }
  if (snapshot?.account) activity.push({ time: lastSync, event: "Account snapshot synced", tone: "success", chip: "Success" });
  if (openTrades != null) activity.push({ time: lastSync, event: "Position sync completed", tone: "success", chip: "Success" });

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6" data-testid="page-mt5-bridge">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">MT5 Bridge</h1>
            <p className="text-sm text-txt-secondary">View your live trading connection, shared bridge access, and account route status.</p>
          </div>
        </div>
        <button onClick={openRubyLiveChat} data-testid="bridge-ask-ruby"
          className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/20">
          <Sparkles className="h-4 w-4" /> Ask {name}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm">
        <span className="flex items-center gap-2 font-medium"><RadioTower className={cn("h-4 w-4", TONE_TEXT[bridgeState.tone])} /> {routeLabel}</span>
        <span className="flex items-center gap-2 font-medium"><UserCheck className={cn("h-4 w-4", TONE_TEXT[approvalTone])} /> {approvalLabel}</span>
        <span className="flex items-center gap-2 font-medium"><Activity className={cn("h-4 w-4", TONE_TEXT[bridgeHealthy ? "success" : "warning"])} /> {bridgeHealthy ? "Bridge Healthy" : "Bridge Checking"}</span>
        {allocation != null && (
          <span className="flex items-center gap-2 font-medium"><Landmark className="h-4 w-4 text-primary" /> Allocation <span className="text-primary">{fmtMoney(allocation)}</span></span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Shared MT5 Bridge" icon={RadioTower}>
          <div className="flex items-start gap-4">
            <span className={cn("grid h-16 w-16 shrink-0 place-items-center rounded-full ring-2",
              bridgeState.tone === "success" ? "bg-success/10 ring-success/40 text-success"
              : bridgeState.tone === "danger" ? "bg-danger/10 ring-danger/40 text-danger"
              : "bg-warning/10 ring-warning/40 text-warning")}>
              <Wifi className="h-7 w-7" />
            </span>
            <div className="min-w-0">
              <div className={cn("text-xl font-bold", TONE_TEXT[bridgeState.tone])}>{bridgeState.label}</div>
              <p className="mt-1 text-sm text-txt-secondary">
                {frozen ? ((mode as any).freezeMessage ?? "Your account is currently frozen. Contact support or wait for review.")
                  : connected ? "Your account is approved to trade through the ARX shared MT5 route."
                  : "The shared MT5 bridge is unavailable right now. Live execution will resume when the bridge reconnects."}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <StatusTile icon={ShieldCheck} label="Bridge" value={bridgeHealthy ? "Healthy" : "Checking"} tone={bridgeHealthy ? "success" : "warning"} />
            <StatusTile icon={UserCheck} label="Access" value={approvalLabel} tone={approvalTone} />
            <StatusTile icon={RouteIcon} label="Route" value={routeLabel} tone="primary" />
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2">
            <MetricTile label="Allocation" value={fmtMoney(allocation)} />
            <MetricTile label="Open P/L" value={openPnl == null ? "—" : fmtMoney(openPnl)} tone={openPnl == null ? "muted" : openPnl >= 0 ? "success" : "danger"} />
            <MetricTile label="Open Trades" value={openTrades == null ? "—" : String(openTrades)} />
          </div>

          <div className="mt-3 flex items-center justify-between rounded-xl border border-border bg-background/40 px-3 py-2">
            <span className="flex items-center gap-2 text-sm text-txt-secondary">
              <RefreshCw className="h-4 w-4 text-txt-muted" /> Last Sync <span className="text-foreground">{lastSync}</span>
            </span>
            <button onClick={refresh} data-testid="bridge-refresh"
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh Status
            </button>
          </div>
        </SectionCard>

        <SectionCard title={`${name}'s Bridge Read`} icon={Sparkles}>
          <p className="text-sm leading-relaxed text-txt-secondary">{rubyRead}</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatusTile icon={ShieldCheck} label="Bridge" value={bridgeHealthy ? "Healthy" : "Unavailable"} tone={bridgeHealthy ? "success" : "warning"} />
            <StatusTile icon={UserCheck} label="Access" value={approvalLabel} tone={approvalTone} />
            <StatusTile icon={Activity} label="Risk" value={riskLabel} tone={riskTone} />
            <StatusTile icon={RouteIcon} label="Execution" value={bridgeHealthy ? "Available" : "Paused"} tone={bridgeHealthy ? "success" : "warning"} />
            <StatusTile icon={Wifi} label="Market Data" value={connected ? "Connected" : "Unavailable"} tone={connected ? "success" : "warning"} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={openRubyLiveChat} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/20">
              <Sparkles className="h-4 w-4" /> Ask {name}
            </button>
            <Link href="/risk-settings" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
              Review Risk
            </Link>
            <Link href="/trade-command-room" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
              Open Trade
            </Link>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Your Trading Route" icon={RouteIcon}>
        <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] md:items-stretch">
          {[
            { n: "1. You", icon: User, tone: "primary" as Tone, desc: "You prepare or confirm a trade." },
            { n: "2. ARX Risk Checks", icon: ShieldCheck, tone: "warning" as Tone, desc: "ARX checks your approval, allocation, risk limits, and account safety controls." },
            { n: "3. Shared MT5 Bridge", icon: RadioTower, tone: "primary" as Tone, desc: "Approved orders route through the connected MT5 bridge." },
            { n: "4. Broker Execution", icon: Landmark, tone: "success" as Tone, desc: "The broker confirms filled, rejected, or pending status." },
            { n: "5. Result Back to App", icon: CheckCircle2, tone: "primary" as Tone, desc: "Your dashboard updates with live status, P/L, and position data." },
          ].map((step, i, arr) => (
            <div key={step.n} className="contents">
              <div className="rounded-xl border border-border bg-background/40 p-3">
                <step.icon className={cn("h-5 w-5", TONE_TEXT[step.tone])} />
                <div className="mt-2 text-sm font-semibold">{step.n}</div>
                <p className="mt-1 text-xs text-txt-muted">{step.desc}</p>
              </div>
              {i < arr.length - 1 && (
                <div className="hidden items-center justify-center text-txt-muted md:flex"><ArrowRight className="h-4 w-4" /></div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="My Bridge Access" icon={UserCheck}>
          <div className="divide-y divide-border/60">
            <Row label="Approval" value={approvalLabel} tone={approvalTone} />
            <Row label="Live Access" value={(mode as any).liveExecutionArmed ? "Enabled" : (mode as any).isLiveShared ? "Enabled" : "Not enabled"} tone={(mode as any).isLiveShared ? "success" : "muted"} />
            <Row label="Allocation" value={fmtMoney(allocation)} />
            <Row label="Allowed Markets" value={Array.isArray((mode as any).allowedSymbols) && (mode as any).allowedSymbols.length ? `${(mode as any).allowedSymbols.length} approved` : "All approved symbols"} />
            <Row label="Max Lot Size" value={(mode as any).maxLotSize != null ? String((mode as any).maxLotSize) : "Not available"} />
            <Row label="Max Open Trades" value={(mode as any).maxOpenTrades != null ? String((mode as any).maxOpenTrades) : "Not available"} />
            <Row label="Stop Loss Required" value={(mode as any).requireStopLoss ? "Yes" : "No"} tone={(mode as any).requireStopLoss ? "success" : "muted"} />
            <Row label="Risk Controls" value={(mode as any).hasRiskCaps ? "Active" : "Standard"} tone={(mode as any).hasRiskCaps ? "success" : "muted"} />
            <Row label="Account Freeze" value={frozen ? "Yes" : "No"} tone={frozen ? "danger" : "success"} />
          </div>
          <Link href="/risk-settings" className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-primary hover:border-primary/40">
            View Risk Limits
          </Link>
        </SectionCard>

        <SectionCard title="Bridge Health" icon={Activity}>
          <div className="divide-y divide-border/60">
            <Row label="Connection" value={connected ? "Healthy" : "Unavailable"} tone={connected ? "success" : "warning"} />
            <Row label="Market Data" value={connected ? "Connected" : "Unavailable"} tone={connected ? "success" : "warning"} />
            <Row label="Order Routing" value={bridgeHealthy ? "Available" : "Paused"} tone={bridgeHealthy ? "success" : "warning"} />
            <Row label="Result Reporting" value={connected ? "Active" : "Paused"} tone={connected ? "success" : "warning"} />
            <Row label="Position Refresh" value={connected ? "Active" : "Paused"} tone={connected ? "success" : "warning"} />
            <Row label="Account Refresh" value={connected ? "Active" : "Paused"} tone={connected ? "success" : "warning"} />
            <Row label="Last Sync" value={lastSync} />
          </div>
          <button onClick={refresh} className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20">
            <RefreshCw className="h-4 w-4" /> Refresh Status
          </button>
        </SectionCard>

        <SectionCard title="If the Bridge Disconnects" icon={Wifi}>
          <p className="text-sm text-txt-secondary">If the shared MT5 bridge disconnects, ARX pauses new live execution until the bridge reconnects.</p>
          <div className="mt-3 divide-y divide-border/60">
            <Row label="New Trades" value="Paused" tone="warning" />
            <Row label="Open Positions" value="Refresh delayed" tone="warning" />
            <Row label={`${name} Analysis`} value="Still available" tone="success" />
            <Row label="Scanner" value="Still available" tone="success" />
            <Row label="Account Values" value="Update when restored" tone="muted" />
          </div>
          <button disabled title="Notification coming soon"
            className="mt-3 inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-txt-muted opacity-70">
            <Bell className="h-4 w-4" /> Notify me when restored
          </button>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Account Snapshot" icon={Landmark}
          action={<Link href="/analytics" className="text-xs text-primary hover:underline">View Account Analytics</Link>}>
          {snapshot?.account || acct ? (
            <div className="divide-y divide-border/60">
              <Row label="Broker" value={snapshot?.broker ?? "—"} />
              <Row label="Account" value={maskAccount(snapshot?.account)} />
              <Row label="Balance" value={fmtMoney(acct?.balance ?? snapshot?.balance, snapshot?.currency)} />
              <Row label="Equity" value={fmtMoney(acct?.equity ?? snapshot?.equity, snapshot?.currency)} />
              <Row label="Free Margin" value={fmtMoney(snapshot?.freeMargin, snapshot?.currency)} />
              <Row label="Margin Level" value={snapshot?.marginLevel != null ? `${Number(snapshot.marginLevel).toFixed(2)}%` : "—"} />
              <Row label="Open Positions" value={openTrades == null ? "—" : String(openTrades)} />
              <Row label="Allocation" value={fmtMoney(allocation)} />
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-txt-muted">Account snapshot will appear once bridge data is available.</p>
          )}
        </SectionCard>

        <SectionCard title="Recent Bridge Activity" icon={Activity}
          action={<Link href="/alerts" className="text-xs text-primary hover:underline">View All</Link>}>
          {activity.length === 0 ? (
            <p className="py-8 text-center text-sm text-txt-muted">Bridge activity will appear here once your account syncs.</p>
          ) : (
            <div className="space-y-2">
              {activity.map((a, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", TONE_DOT[a.tone])} />
                  <span className="w-24 shrink-0 text-xs text-txt-muted">{a.time}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{a.event}</span>
                  <Chip tone={a.tone}>{a.chip}</Chip>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <HelpCircle className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-semibold">Need help?</div>
            <p className="text-sm text-txt-secondary">Learn more about how the ARX shared MT5 bridge works and how it keeps your account safe.</p>
          </div>
        </div>
        <a href={`${BASE}/help`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
          Bridge Help Center <ChevronRight className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}
