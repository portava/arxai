import { mt5StatusReadOptions } from "@/hooks/readSharedAccountSummary";
import React from "react";
import { Link } from "wouter";
import { useGetMt5Status, useGetBotStatus, getGetMt5StatusQueryKey, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { SymbolPicker } from "./SymbolPicker";
import { NotificationBell } from "@/components/alerts/NotificationBell";
import { OneClickModeToggle } from "@/components/oneclick/OneClickModeToggle";
import { WifiOff, Lock, Zap, Plug } from "lucide-react";
import { getCurrentSession } from "@/lib/symbol-context";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { StatusBadgeRow, type StatusPill } from "@/components/ui/StatusBadgeRow";
import { Menu } from "lucide-react";
import { ARXLogoMark, ARXWordmark } from "@/components/brand/ARXLogo";
import { useAllUnlocks } from "@/hooks/useFeatureUnlock";
import { useCurrentUser, useLogout } from "@/hooks/useCurrentUser";
import { useViewMode } from "@/hooks/useViewMode";
import { LogOut, User as UserIcon, ShieldCheck, Eye } from "lucide-react";

const CLOCK_WINDOW_LABEL = {
  ASIA: "Asia", LONDON: "London", NEW_YORK: "New York", OFF: "Outside reference windows",
};

// This estimate is a reference clock, never market/session evidence. Keep its
// timer inside the open details drawer rather than rerendering the chart shell.
function ClockSessionEstimate() {
  const [session, setSession] = React.useState(getCurrentSession);
  React.useEffect(() => {
    const refresh = () => setSession(getCurrentSession());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <>
    <DetailRow label="UTC clock window" value={`${CLOCK_WINDOW_LABEL[session]} (estimate)`} />
    <p className="text-muted-foreground">
      Fixed UTC-hour estimate only. It does not verify the selected market's session,
      opening hours, holidays, daylight-saving changes, or the chart's historical time.
    </p>
  </>;
}

const MODE_META = {
  MOCK: { tone: "neutral" as const, icon: WifiOff, label: "Mock" },
  DEMO: { tone: "info" as const, icon: Plug, label: "Demo" },
  LIVE_LOCKED: { tone: "warning" as const, icon: Lock, label: "Live Locked" },
  LIVE: { tone: "danger" as const, icon: Zap, label: "LIVE" },
} as const;

export function Topbar({ onMobileMenu }: { onMobileMenu?: React.ReactNode }) {
  const unlocks = useAllUnlocks();
  // Only poll MT5 / bot status once the user has unlocked those surfaces.
  // Fresh browser sessions get no leak of the global single-tenant state
  // (account, broker, mode, running flag) into the global header.
  const { data: mt5 } = useGetMt5Status({
    query: {
      queryKey: getGetMt5StatusQueryKey(), ...mt5StatusReadOptions,
      refetchInterval: 5000,
      enabled: unlocks.mt5,
    },
  });
  const { data: bot } = useGetBotStatus({
    query: {
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: 5000,
      enabled: unlocks.simulator || unlocks.mt5,
    },
  });
  const modeMeta = (mt5 && MODE_META[mt5.mode as keyof typeof MODE_META]) || MODE_META.MOCK;
  const ModeIcon = modeMeta.icon;

  return (
    <header className="relative h-14 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="h-full px-3 md:px-6 flex items-center gap-3">
        {onMobileMenu}
        <div className="md:hidden flex items-center gap-2 mr-1" data-testid="topbar-mobile-brand">
          <ARXLogoMark size="sm" mode="dark" />
          <ARXWordmark size="sm" mode="dark" />
        </div>

        {/* Active symbol picker */}
        <div className="flex items-center gap-2">
          <span className="hidden lg:inline text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</span>
          <SymbolPicker />
        </div>

        {/* Compact status row — pills are visible inline on desktop and the
            full row is also tappable to open a Sheet with detailed status
            (EA heartbeat, bridge mode, broker/server, feed status, etc).
            Per-user isolation still enforced server-side. */}
        <CompactStatusRow
          mt5={mt5}
          bot={bot}
          unlocks={unlocks}
          modeLabel={modeMeta.label}
          modeTone={modeMeta.tone}
          ModeIcon={ModeIcon}
        />

        <div className="ml-auto flex items-center gap-1">
          <OneClickModeToggle />
          <ViewModeSwitch />
          <NotificationBell />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

export function ViewModeSwitch() {
  const { canToggle, viewMode, setViewMode } = useViewMode();
  if (!canToggle) return null;
  const isAdminView = viewMode === "admin";
  const next = isAdminView ? "user" : "admin";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setViewMode(next)}
      data-testid="button-viewmode-toggle"
      aria-label={isAdminView ? "Switch to User view" : "Switch back to Admin view"}
      title={isAdminView ? "Currently in Admin view — tap to preview as a regular user" : "Currently in User view — tap to return to Admin view"}
      className="min-h-[44px] h-11 px-3 text-xs gap-1.5 touch-manipulation"
    >
      {isAdminView ? <ShieldCheck className="w-4 h-4 text-amber-400" /> : <Eye className="w-4 h-4 text-sky-400" />}
      <span>{isAdminView ? "Admin" : "User"}</span>
    </Button>
  );
}

function UserMenu() {
  const { user } = useCurrentUser();
  const logout = useLogout();
  if (!user) return null;
  const label = user.name || user.email;
  return (
    <div className="flex items-center gap-2 ml-1 pl-2 border-l border-border">
      <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-current-user">
        <UserIcon className="w-3.5 h-3.5" />
        <span className="max-w-[140px] truncate">{label}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
        data-testid="button-logout"
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="w-4 h-4" />
      </Button>
    </div>
  );
}

type CompactStatusRowProps = {
  mt5: any;
  bot: any;
  unlocks: ReturnType<typeof useAllUnlocks>;
  modeLabel: string;
  modeTone: "neutral" | "info" | "warning" | "danger";
  ModeIcon: React.ComponentType<{ className?: string }>;
};

function CompactStatusRow(p: CompactStatusRowProps) {
  const pills: StatusPill[] = [
    { id: "session", label: "Session", value: "Unverified", legacyTestId: "badge-session", tone: "neutral" },
  ];
  if (p.unlocks.mt5) {
    pills.push({ id: "mt5", label: "MT5", value: p.mt5?.connected ? "ON" : "OFF",
      legacyTestId: "badge-mt5-connection",
      tone: p.mt5?.connected ? "success" : "neutral" });
    pills.push({ id: "mode", label: "Mode", value: p.modeLabel,
      legacyTestId: "badge-mode",
      tone: p.modeTone === "danger" ? "danger" : p.modeTone === "warning" ? "warning" : "neutral" });
  }
  if ((p.unlocks.simulator || p.unlocks.mt5) && p.bot) {
    pills.push({ id: "bot", label: "Bot",
      value: p.bot.isRunning ? (p.bot.isPaused ? "Paused" : "Running") : "Stopped",
      tone: p.bot.isRunning ? (p.bot.isPaused ? "warning" : "success") : "neutral" });
  }

  const drawer = (
    <div className="space-y-3 text-xs">
      {/* A session NAME bucketed by UTC hours — not the page's display time zone. */}
      <DetailRow label="Trading session (by UTC hours)" value={p.sessionLabel} />
      {p.unlocks.mt5 ? (
        <>
          <DetailRow label="MT5 mode" value={p.modeLabel} />
          <DetailRow label="MT5 connected" value={bridge.connectedText} />
        </>
      ) : (
        // The status query is disabled until MT5 is turned on for this header,
        // so nothing is being checked. Only the admin-only welcome checklist on
        // the dashboard turns it on; the "Connect MT5" buttons traders see open
        // My MT5 and do not change this header.
        <>
          <DetailRow label="MT5 status" value="not checked here" />
          <p className="text-[10px] text-muted-foreground" data-testid="topbar-mt5-not-checked">
            MT5 status is turned off in this header for your account in this browser, so nothing is read here.{" "}
            <Link className="text-primary underline" href="/my-mt5">Open My MT5</Link> for your bridge status.
            {p.viewerIsAdmin
              ? ' To show it here, press "Connect MT5" in the welcome checklist (Dashboard → System Health · Admin → Setup & readiness).'
              : null}
          </p>
        </>
      )}
      <ClockSessionEstimate />
      {(p.mt5?.accountSnapshot?.account ?? p.mt5?.account) != null && (
        <DetailRow label="Account" value={String(p.mt5?.accountSnapshot?.account ?? p.mt5?.account)} />
      )}
      {(p.mt5?.accountSnapshot?.broker ?? p.mt5?.broker) && (
        <DetailRow label="Broker" value={String(p.mt5?.accountSnapshot?.broker ?? p.mt5?.broker)} />
      )}
      {p.mt5?.lastHeartbeatAt && <DetailRow label="Last heartbeat" value={new Date(p.mt5.lastHeartbeatAt as string).toLocaleTimeString()} />}
      {p.bot && (
        <>
          <DetailRow label="Bot state" value={p.bot.isRunning ? (p.bot.isPaused ? "Paused" : "Running") : "Stopped"} />
          {(p.bot as any).lastScanAt && <DetailRow label="Last scan" value={new Date((p.bot as any).lastScanAt).toLocaleTimeString()} />}
        </>
      )}
      <div className="pt-2 border-t space-y-1">
        <Link className="block text-primary underline" href="/mt5-setup">MT5 setup &amp; bridge token →</Link>
        {p.viewerIsAdmin && (
          <>
            <Link className="block text-primary underline" href="/admin/operator-command-center">Operator dashboard →</Link>
            <Link className="block text-primary underline" href="/admin/diagnostics">Admin diagnostics →</Link>
          </>
        )}
        <Link className="block text-primary underline" href="/risk-command-center">Kill switch / risk controls →</Link>
      </div>
      {p.viewerIsAdmin && (
        <p className="text-[10px] text-muted-foreground pt-2 border-t">
          Live broker dispatch stays OFF unless an operator flips
          ARX_LIVE_BROKER_EXECUTION_ENABLED AND all 16 Phase B gates pass.
        </p>
      )}
    </div>
  );

  return (
    <div className="hidden md:block ml-2 min-w-0 max-w-md flex-shrink">
      <StatusBadgeRow pills={pills} drawer={drawer} testId="topbar-status-row" />
      {/* Legacy E2E selectors — preserved as hidden markers so existing tests
          targeting badge-session / badge-mt5-connection / badge-mode keep
          finding the same data in the DOM after the StatusBadgeRow refactor. */}
      <span className="sr-only" data-testid="badge-session">Unverified</span>
      {p.unlocks.mt5 && (
        <>
          <span className="sr-only" data-testid="badge-mt5-connection">{p.mt5?.connected ? "connected" : "disconnected"}</span>
          <span className="sr-only" data-testid="badge-mode">{p.modeLabel}</span>
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center border-b border-border/40 pb-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export function MobileMenuTrigger({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" data-testid="button-mobile-menu">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0 w-72 border-sidebar-border">
        {children(() => setOpen(false))}
      </SheetContent>
    </Sheet>
  );
}
